import { z } from 'zod';
import { ActionError, defineAction } from '../lib/dispatch.js';
import { audit } from '../lib/audit.js';
import { WIRE_STATUS } from '../lib/orderState.js';

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csvRows = (header: string[], rows: unknown[][]): string =>
  [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');

const today = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------

defineAction('adminExportCsv', {
  tier: 'staff',
  schema: z.object({
    tab: z.enum(['Products', 'PriceTiers', 'Brands', 'Requests', 'RequestLines']),
  }),
  async handler(input, ctx) {
    let csv: string;

    switch (input.tab) {
      case 'Products': {
        const rows = await ctx.db.product.findMany({
          where: { tenantId: ctx.tenantId },
          include: { brand: { select: { code: true } } },
          orderBy: { sku: 'asc' },
        });
        csv = csvRows(
          ['sku', 'name', 'brand_id', 'category', 'subcategory', 'description',
           'specs', 'moq', 'gst_rate', 'hsn', 'mrp', 'lead_time', 'on_hand',
           'reserved', 'safety_stock', 'reorder_point', 'visible', 'show_price',
           'supply_mode', 'vendor', 'vendor_moq', 'batch_qty'],
          rows.map((r) => [
            r.sku, r.name, r.brand?.code ?? '', r.category ?? '', r.subcategory ?? '',
            r.description ?? '', r.specs.join('|'), r.moq, Number(r.gstRate),
            r.hsn ?? '', r.mrp ? Number(r.mrp) : '', r.leadTime ?? '',
            r.onHand, r.reserved, r.safetyStock, r.reorderPoint,
            r.visible, r.showPrice, r.supplyMode ?? '', r.vendor ?? '',
            r.vendorMoq ?? '', r.batchQty ?? '',
          ]),
        );
        break;
      }
      case 'PriceTiers': {
        const rows = await ctx.db.priceTier.findMany({
          where: { tenantId: ctx.tenantId },
          include: { product: { select: { sku: true } } },
          orderBy: [{ productId: 'asc' }, { minQty: 'asc' }],
        });
        csv = csvRows(
          ['sku', 'min_qty', 'unit_price', 'gst'],
          rows.map((t) => [
            t.product.sku, t.minQty, Number(t.unitPrice),
            t.gst === null ? '' : Number(t.gst),
          ]),
        );
        break;
      }
      case 'Brands': {
        const rows = await ctx.db.brand.findMany({
          where: { tenantId: ctx.tenantId },
          orderBy: [{ sort: 'asc' }, { name: 'asc' }],
        });
        csv = csvRows(
          ['brand_id', 'name', 'logo_url', 'description', 'active', 'sort'],
          rows.map((b) => [b.code, b.name, b.logoUrl ?? '', b.description ?? '', b.active, b.sort]),
        );
        break;
      }
      case 'Requests': {
        const rows = await ctx.db.request.findMany({
          where: { tenantId: ctx.tenantId },
          orderBy: { createdAt: 'asc' },
        });
        csv = csvRows(
          ['request_id', 'created', 'status', 'company', 'contact', 'email', 'phone',
           'gstin', 'notes', 'total_est', 'pi_number', 'pi_total', 'po_number',
           'place_of_supply', 'stock_state'],
          rows.map((r) => [
            r.ref, r.createdAt.toISOString(), WIRE_STATUS[r.status], r.company ?? '',
            r.contact ?? '', r.email ?? '', r.phone ?? '', r.gstin ?? '', r.notes ?? '',
            Number(r.totalEst), r.piNumber ?? '', r.piTotal ? Number(r.piTotal) : '',
            r.poNumber ?? '', r.placeOfSupply ?? '',
            r.stockState === 'none' ? '' : r.stockState,
          ]),
        );
        break;
      }
      case 'RequestLines': {
        const rows = await ctx.db.requestLine.findMany({
          where: { tenantId: ctx.tenantId },
          include: { request: { select: { ref: true } } },
          orderBy: [{ requestId: 'asc' }, { line: 'asc' }],
        });
        csv = csvRows(
          ['request_id', 'line', 'sku', 'name', 'qty', 'unit_price', 'line_total',
           'list_price', 'gst', 'hsn'],
          rows.map((l) => [
            l.request.ref, l.line, l.sku, l.name, l.qty, Number(l.unitPrice),
            Number(l.lineTotal), l.listPrice ? Number(l.listPrice) : '',
            l.gst === null ? '' : Number(l.gst), l.hsn ?? '',
          ]),
        );
        break;
      }
    }

    await audit(ctx, 'export_csv', input.tab);
    return {
      filename: `merchforce_${input.tab.toLowerCase()}_${today()}.csv`,
      csv,
    };
  },
});

/**
 * Kept for contract compatibility, and it now has nothing to do.
 *
 * In the sheet a SKU could appear on two rows, and a tier could be entered
 * twice for the same break, because nothing stopped it -- this action swept up
 * afterwards. Postgres has a unique constraint on (tenant, sku) and on
 * (product, min_qty), so the duplicate is rejected at write time and never
 * exists to be cleaned.
 */
defineAction('adminDedupe', {
  tier: 'admin',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    await audit(ctx, 'dedupe', undefined, 'no-op: uniqueness enforced by the database');
    return {
      removed_products: 0,
      removed_tiers: 0,
      note: 'Duplicates are prevented at write time — nothing to clean up.',
    };
  },
});

/**
 * Replaces the Google Sheet stock connector.
 *
 * The ten sync actions existed so a supplier could keep managing stock in their
 * own spreadsheet while a script pushed it into Apps Script. With stock in a
 * real database behind a real API, the need that remains is a bulk update from
 * whatever they keep it in -- which is a CSV, in one screen, not a connector
 * script pasted into someone's sheet.
 *
 * Two columns: sku, on_hand. Anything else is ignored. Every change writes a
 * StockLog row, so a bulk import is as auditable as a manual edit.
 */
defineAction('adminStockImport', {
  tier: 'staff',
  schema: z.object({
    csv: z.string().min(1, 'Paste or upload a CSV first'),
    dry_run: z.boolean().optional(),
  }),
  async handler(input, ctx) {
    const lines = input.csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) throw new ActionError('The CSV needs a header row and at least one row');

    const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
    const iSku = header.indexOf('sku');
    const iQty = header.findIndex((h) => h === 'on_hand' || h === 'stock' || h === 'qty');
    if (iSku < 0 || iQty < 0) {
      throw new ActionError('The CSV needs a "sku" column and an "on_hand" column');
    }

    const products = await ctx.db.product.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, sku: true, onHand: true },
    });
    const bySku = new Map(products.map((p) => [p.sku, p]));

    const changes: { sku: string; from: number; to: number; delta: number }[] = [];
    const unknown: string[] = [];
    const bad: string[] = [];

    for (const row of lines.slice(1)) {
      const cells = row.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      const sku = (cells[iSku] ?? '').toUpperCase();
      if (!sku) continue;
      const p = bySku.get(sku);
      if (!p) {
        unknown.push(sku);
        continue;
      }
      const qty = Number(cells[iQty]);
      if (!Number.isFinite(qty) || qty < 0) {
        bad.push(`${sku} (${cells[iQty] ?? ''})`);
        continue;
      }
      const to = Math.round(qty);
      if (to === p.onHand) continue;
      changes.push({ sku, from: p.onHand, to, delta: to - p.onHand });
    }

    // A dry run is the default posture for anything that rewrites stock in
    // bulk: the console shows what would change before it changes it.
    if (input.dry_run !== false) {
      return {
        dry_run: true,
        changes: changes.slice(0, 200),
        changed: changes.length,
        unknown_skus: unknown.slice(0, 50),
        unknown_count: unknown.length,
        invalid: bad.slice(0, 50),
        invalid_count: bad.length,
      };
    }

    for (const c of changes) {
      const p = bySku.get(c.sku)!;
      await ctx.db.product.update({ where: { id: p.id }, data: { onHand: c.to } });
      await ctx.db.stockLog.create({
        data: {
          tenantId: ctx.tenantId,
          productId: p.id,
          sku: c.sku,
          delta: c.delta,
          reason: 'csv import',
          actor: ctx.actor,
        },
      });
    }

    await audit(
      ctx, 'stock_import', undefined,
      `${changes.length} changed, ${unknown.length} unknown, ${bad.length} invalid`,
    );
    return {
      dry_run: false,
      changed: changes.length,
      unknown_count: unknown.length,
      invalid_count: bad.length,
    };
  },
});
