import { z } from 'zod';
import { Prisma } from '../generated/prisma/index.js';
import { ActionError, defineAction } from '../lib/dispatch.js';
import { audit } from '../lib/audit.js';
import { getPublicSettings, saveSettings } from '../lib/settings.js';
import { buildKey, putObject } from '../lib/storage.js';
import { env } from '../env.js';
import type { TenantClient } from '../lib/prisma.js';

const dec = (v: Prisma.Decimal | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);

/** Available to promise, as atp_ in Stock.gs. */
const atp = (p: { onHand: number; reserved: number; safetyStock: number }): number =>
  Math.max(0, p.onHand - p.reserved - p.safetyStock);

/**
 * Product images go in customer-facing decks and quotations, so they are served
 * from the bucket's public prefix rather than as presigned URLs -- a presigned
 * link would expire inside an emailed PDF. Account files, PIs and POs are the
 * opposite case and stay private (see storage.presignGet).
 */
const imageUrl = (key: string): string => `${env.S3_PUBLIC_BASE}/${key}`;

const skuKey = (v: unknown): string => String(v ?? '').trim().toUpperCase();

async function findProductBySku(
  db: TenantClient,
  tenantId: string,
  sku: string,
) {
  return db.product.findUnique({
    where: { tenantId_sku: { tenantId, sku: skuKey(sku) } },
  });
}

// ---------------------------------------------------------------------------

defineAction('adminCatalog', {
  tier: 'staff',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    const [products, brands] = await Promise.all([
      ctx.db.product.findMany({
        where: { tenantId: ctx.tenantId },
        include: {
          priceTiers: { orderBy: { minQty: 'asc' } },
          // brand_id on the wire is the human code (BR-XXXX), not the row id.
          brand: { select: { code: true } },
        },
        orderBy: { sku: 'asc' },
      }),
      ctx.db.brand.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      }),
    ]);

    return {
      products: products.map((r) => ({
        sku: r.sku,
        name: r.name,
        brand_id: r.brand?.code ?? '',
        category: r.category ?? '',
        subcategory: r.subcategory ?? '',
        description: r.description ?? '',
        // The sheet stored these '|'-joined; the console still expects that.
        specs: r.specs.join('|'),
        images: r.imageKeys.map(imageUrl),
        moq: r.moq,
        gst_rate: dec(r.gstRate),
        lead_time: r.leadTime ?? '',
        mrp: r.mrp ? dec(r.mrp) : '',
        hsn: r.hsn ?? '',
        on_hand: r.onHand,
        reserved: r.reserved,
        safety_stock: r.safetyStock,
        reorder_point: r.reorderPoint,
        atp: atp(r),
        visible: r.visible,
        show_price: r.showPrice,
        tiers: r.priceTiers.map((t) => ({
          min: t.minQty,
          price: dec(t.unitPrice),
          gst: t.gst === null ? '' : dec(t.gst),
        })),
      })),
      brands: brands.map((b) => ({
        id: b.code,
        name: b.name,
        logo: b.logoUrl ?? '',
        desc: b.description ?? '',
        active: b.active,
        sort: b.sort,
      })),
    };
  },
});

const tierSchema = z.object({
  min: z.coerce.number().int().nonnegative(),
  price: z.coerce.number().nonnegative(),
  gst: z.union([z.coerce.number(), z.literal('')]).optional(),
});

defineAction('adminProductSave', {
  tier: 'staff',
  schema: z.object({
    product: z.object({
      sku: z.string().trim().min(1, 'SKU and name are required'),
      name: z.string().trim().min(1, 'SKU and name are required'),
      brand_id: z.string().optional(),
      category: z.string().optional(),
      subcategory: z.string().optional(),
      description: z.string().optional(),
      specs: z.string().optional(),
      images: z.array(z.string()).optional(),
      moq: z.coerce.number().int().positive().optional(),
      gst_rate: z.coerce.number().optional(),
      lead_time: z.union([z.coerce.number(), z.literal('')]).optional(),
      mrp: z.union([z.coerce.number(), z.literal('')]).optional(),
      hsn: z.string().optional(),
      on_hand: z.coerce.number().int().optional(),
      safety_stock: z.coerce.number().int().optional(),
      reorder_point: z.coerce.number().int().optional(),
      visible: z.boolean().optional(),
      show_price: z.boolean().optional(),
      tiers: z.array(tierSchema).optional(),
    }),
  }),
  async handler(input, ctx) {
    const d = input.product;
    const sku = skuKey(d.sku);
    const moq = d.moq ?? 1;

    // The first tier must start at the MOQ (MOQ 1 for a flat price). Sorting
    // first means the console can send tiers in any order.
    const tiers = [...(d.tiers ?? [])].sort((a, b) => a.min - b.min);
    const first = tiers[0];
    if (first && first.min !== moq) {
      throw new ActionError(`The first price tier must start at the MOQ (${moq})`);
    }

    // Brands are addressed by their human code on the wire; resolve to the row.
    let brandId: string | null = null;
    if (d.brand_id) {
      const brand = await ctx.db.brand.findUnique({
        where: { tenantId_code: { tenantId: ctx.tenantId, code: d.brand_id } },
      });
      if (!brand) throw new ActionError(`No such brand: ${d.brand_id}`);
      brandId = brand.id;
    }

    const existing = await findProductBySku(ctx.db, ctx.tenantId, sku);

    // Images arrive as URLs (that is what adminCatalog handed out); store keys.
    const imageKeys = (d.images ?? []).map((u) =>
      u.startsWith(env.S3_PUBLIC_BASE) ? u.slice(env.S3_PUBLIC_BASE.length + 1) : u,
    );

    const base = {
      name: d.name,
      brandId,
      category: d.category ?? null,
      subcategory: d.subcategory ?? null,
      description: d.description ?? null,
      specs: (d.specs ?? '').split('|').filter(Boolean),
      imageKeys,
      moq,
      gstRate: new Prisma.Decimal(d.gst_rate ?? 18),
      leadTime: d.lead_time === '' || d.lead_time === undefined ? null : Number(d.lead_time),
      mrp: d.mrp === '' || d.mrp === undefined ? null : new Prisma.Decimal(d.mrp),
      hsn: (d.hsn ?? '').trim() || null,
      safetyStock: d.safety_stock ?? 0,
      reorderPoint: d.reorder_point ?? 0,
      visible: d.visible ?? true,
      showPrice: d.show_price ?? true,
    };

    let productId: string;

    if (existing) {
      const nextOnHand = d.on_hand ?? existing.onHand;
      const delta = nextOnHand - existing.onHand;

      // `reserved` is owned by the order lifecycle, never by this form -- a
      // product edit must not silently release stock promised to an order.
      await ctx.db.product.update({
        where: { id: existing.id },
        data: { ...base, onHand: nextOnHand },
      });
      productId = existing.id;

      // Every movement of on-hand is logged, including a manual correction.
      if (delta !== 0) {
        await ctx.db.stockLog.create({
          data: {
            tenantId: ctx.tenantId,
            productId: existing.id,
            sku,
            delta,
            reason: 'manual adjust',
            actor: ctx.actor,
          },
        });
      }
    } else {
      const created = await ctx.db.product.create({
        data: {
          ...base,
          tenantId: ctx.tenantId,
          sku,
          onHand: d.on_hand ?? 0,
          reserved: 0,
        },
      });
      productId = created.id;
      if (created.onHand !== 0) {
        await ctx.db.stockLog.create({
          data: {
            tenantId: ctx.tenantId,
            productId,
            sku,
            delta: created.onHand,
            reason: 'opening balance',
            actor: ctx.actor,
          },
        });
      }
    }

    // Tiers are replaced wholesale, as replaceChildRows_ did.
    await ctx.db.priceTier.deleteMany({ where: { productId } });
    if (tiers.length) {
      await ctx.db.priceTier.createMany({
        data: tiers.map((t) => ({
          tenantId: ctx.tenantId,
          productId,
          minQty: t.min,
          unitPrice: new Prisma.Decimal(t.price),
          gst:
            t.gst === '' || t.gst === undefined || t.gst === null
              ? null
              : new Prisma.Decimal(t.gst),
        })),
      });
    }

    await audit(ctx, 'product_save', sku);
    return { sku };
  },
});

defineAction('adminProductDelete', {
  tier: 'staff',
  schema: z.object({ sku: z.string().trim().min(1) }),
  async handler(input, ctx) {
    const p = await findProductBySku(ctx.db, ctx.tenantId, input.sku);
    if (!p) throw new ActionError('Not found');
    // Soft delete, as before: orders and stock history reference the SKU, and
    // a hard delete would strand them.
    await ctx.db.product.update({ where: { id: p.id }, data: { visible: false } });
    await audit(ctx, 'product_hide', p.sku);
    return {};
  },
});

defineAction('adminBrandSave', {
  tier: 'staff',
  schema: z.object({
    brand: z.object({
      id: z.string().optional(),
      name: z.string().trim().min(1, 'Brand name required'),
      logo: z.string().optional(),
      desc: z.string().optional(),
      active: z.boolean().optional(),
      sort: z.coerce.number().int().optional(),
    }),
  }),
  async handler(input, ctx) {
    const d = input.brand;
    const code =
      d.id || `BR-${d.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)}`;

    const data = {
      name: d.name,
      logoUrl: d.logo ?? null,
      description: d.desc ?? null,
      active: d.active !== false,
      sort: d.sort ?? 0,
    };

    await ctx.db.brand.upsert({
      where: { tenantId_code: { tenantId: ctx.tenantId, code } },
      create: { ...data, tenantId: ctx.tenantId, code },
      update: data,
    });

    await audit(ctx, 'brand_save', code);
    return { id: code };
  },
});

defineAction('adminBrandDelete', {
  tier: 'staff',
  schema: z.object({ id: z.string().trim().min(1) }),
  async handler(input, ctx) {
    const brand = await ctx.db.brand.findUnique({
      where: { tenantId_code: { tenantId: ctx.tenantId, code: input.id } },
    });
    if (!brand) throw new ActionError('Not found');

    const used = await ctx.db.product.count({ where: { brandId: brand.id } });
    if (used > 0) throw new ActionError('Brand has products — reassign them first');

    await ctx.db.brand.delete({ where: { id: brand.id } });
    await audit(ctx, 'brand_delete', input.id);
    return {};
  },
});

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

defineAction('adminImageUpload', {
  tier: 'staff',
  schema: z.object({
    data: z.string().min(1, 'data + filename required'),
    filename: z.string().min(1, 'data + filename required'),
    mime: z.string().optional(),
  }),
  async handler(input, ctx) {
    const mime = input.mime ?? 'image/png';
    // The type is checked, not just trusted: the old version wrote whatever
    // mime the client claimed into a publicly readable file.
    if (!ALLOWED_IMAGE.has(mime)) {
      throw new ActionError(`Unsupported image type: ${mime}`);
    }

    const b64 = input.data.replace(/^data:[^;]+;base64,/, '');
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length === 0) throw new ActionError('Image is empty or not valid base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new ActionError('Image over 4MB');

    const key = buildKey(ctx.tenantId, 'images', input.filename);
    await putObject({ key, body: bytes, contentType: mime });

    await audit(ctx, 'image_upload', input.filename, key);
    // file_id is kept in the reply for contract compatibility; the key is the
    // identifier that matters now.
    return { url: imageUrl(key), file_id: key };
  },
});

defineAction('adminSettings', {
  tier: 'admin',
  schema: z.object({ save: z.record(z.unknown()).optional() }),
  async handler(input, ctx) {
    if (input.save) {
      await saveSettings(ctx.db, ctx.tenantId, input.save);
      await audit(ctx, 'settings_save', undefined, Object.keys(input.save).join(','));
    }
    const settings = await getPublicSettings(ctx.db, ctx.tenantId);
    const relayRow = await ctx.db.setting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: 'relay_last' } },
    });
    let relay_status: unknown = null;
    try {
      relay_status = relayRow?.value ? JSON.parse(relayRow.value) : null;
    } catch {
      relay_status = null;
    }
    return { settings, relay_status };
  },
});
