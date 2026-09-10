import { z } from 'zod';
import { ActionError, defineAction, type ActionContext } from '../lib/dispatch.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { buildKey, deleteObject, presignGet, putObject } from '../lib/storage.js';
import { htmlToPdf } from '../lib/pdf.js';
import { deckHtml, type DeckProduct } from '../lib/deck.js';
import { deckPptx } from '../lib/deckPptx.js';
import { env } from '../env.js';

const MAX_PRODUCTS = 40;

const imageUrl = (key: string): string => `${env.S3_PUBLIC_BASE}/${key}`;

/**
 * Resolve SKUs to the shape the builders want, preserving the order they were
 * asked for -- the deck is a document, and the order the products appear in is
 * the salesperson's choice, not the database's.
 */
async function deckProducts(
  ctx: ActionContext,
  skus: string[],
): Promise<DeckProduct[]> {
  const wanted = skus.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const rows = await ctx.db.product.findMany({
    where: { tenantId: ctx.tenantId, sku: { in: wanted } },
    include: {
      brand: { select: { name: true, code: true } },
      priceTiers: { orderBy: { minQty: 'asc' } },
    },
  });
  const bySku = new Map(rows.map((r) => [r.sku, r]));

  return wanted
    .map((sku) => {
      const r = bySku.get(sku);
      if (!r) return null;
      return {
        sku: r.sku,
        name: r.name,
        brand: r.brand?.name ?? r.brand?.code ?? '',
        category: r.category ?? '',
        description: r.description ?? '',
        specs: r.specs.map((x) => x.trim()).filter(Boolean),
        image: r.imageKeys[0] ? imageUrl(r.imageKeys[0]) : '',
        moq: r.moq || 1,
        gst: Number(r.gstRate),
        hsn: r.hsn ?? '',
        leadTime: r.leadTime ?? '',
        mrp: r.mrp ? Number(r.mrp) : 0,
        atp: Math.max(0, r.onHand - r.reserved - r.safetyStock),
        tiers: r.priceTiers.map((t) => ({ min: t.minQty, price: Number(t.unitPrice) })),
      } satisfies DeckProduct;
    })
    .filter((x): x is DeckProduct => x !== null);
}

async function deckOut(d: {
  id: string; name: string; skus: string[]; companyId: string | null;
  company: string | null; pdfKey: string | null; pptxKey: string | null;
  createdBy: string | null; createdAt: Date; sentTo: string | null;
  lastSent: Date | null;
}) {
  return {
    id: d.id,
    name: d.name,
    skus: d.skus,
    company_id: d.companyId ?? '',
    company: d.company ?? '',
    pdf_url: d.pdfKey ? await presignGet(d.pdfKey) : '',
    pptx_url: d.pptxKey ? await presignGet(d.pptxKey) : '',
    folder_id: '',
    created_by: d.createdBy ?? '',
    created: d.createdAt.toISOString(),
    sent_to: d.sentTo ?? '',
    last_sent: d.lastSent ? d.lastSent.toISOString() : '',
  };
}

// ---------------------------------------------------------------------------

defineAction('adminDecks', {
  tier: 'staff',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    const rows = await ctx.db.deck.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return { decks: await Promise.all(rows.map(deckOut)) };
  },
});

defineAction('adminDeckBuild', {
  tier: 'staff',
  schema: z.object({
    name: z.string().trim().min(1, 'Give the deck a name'),
    skus: z.array(z.string()).min(1, 'Pick at least one product'),
    company: z.string().optional(),
    company_id: z.string().optional(),
  }),
  async handler(input, ctx) {
    if (input.skus.length > MAX_PRODUCTS) {
      throw new ActionError(`${MAX_PRODUCTS} products per deck at most — split it`);
    }

    const products = await deckProducts(ctx, input.skus);
    if (!products.length) throw new ActionError('None of those SKUs exist');

    const settings = await getSettings(ctx.db, ctx.tenantId);
    const deck = { name: input.name, company: input.company ?? '' };

    // Both formats come from the same product data, so the PDF and the PPTX
    // can never disagree about a price or a stock figure.
    const [pdf, pptx] = await Promise.all([
      htmlToPdf(deckHtml(deck, products, settings), {
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      }),
      deckPptx(deck, products, settings),
    ]);

    const safe = input.name.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60).trim();
    const pdfKey = buildKey(ctx.tenantId, 'decks', `${safe}.pdf`);
    const pptxKey = buildKey(ctx.tenantId, 'decks', `${safe}.pptx`);

    await Promise.all([
      putObject({ key: pdfKey, body: pdf, contentType: 'application/pdf' }),
      putObject({
        key: pptxKey,
        body: pptx,
        contentType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    ]);

    const row = await ctx.db.deck.create({
      data: {
        tenantId: ctx.tenantId,
        name: input.name,
        skus: products.map((p) => p.sku),
        companyId: input.company_id || null,
        company: input.company || null,
        pdfKey,
        pptxKey,
        createdBy: ctx.actor,
      },
    });

    await audit(ctx, 'deck_build', row.id, `${products.length} products`);
    return {
      id: row.id,
      pdf_url: await presignGet(pdfKey),
      pptx_url: await presignGet(pptxKey),
      products: products.length,
      missing: input.skus.length - products.length,
    };
  },
});

defineAction('adminDeckSend', {
  tier: 'staff',
  schema: z.object({
    id: z.string().min(1),
    to: z
      .string()
      .trim()
      .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'A valid email address is required'),
    message: z.string().optional(),
  }),
  async handler(input, ctx) {
    const d = await ctx.db.deck.findFirst({
      where: { id: input.id, tenantId: ctx.tenantId },
    });
    if (!d) throw new ActionError('Deck not found');

    // Deck links are presigned and expire, so the recipient gets a fresh pair
    // at send time rather than whatever was minted when the deck was built.
    const pdfUrl = d.pdfKey ? await presignGet(d.pdfKey, 7 * 24 * 3600) : '';
    const pptxUrl = d.pptxKey ? await presignGet(d.pptxKey, 7 * 24 * 3600) : '';

    await ctx.db.deck.update({
      where: { id: d.id },
      data: {
        sentTo: d.sentTo ? `${d.sentTo}, ${input.to}` : input.to,
        lastSent: new Date(),
      },
    });
    await audit(ctx, 'deck_send', d.id, input.to);

    // Reports honestly rather than claiming a send: the mail provider is wired
    // in the mail phase.
    return {
      sent: false,
      to: input.to,
      pdf_url: pdfUrl,
      pptx_url: pptxUrl,
      pending: 'mail provider not yet configured',
    };
  },
});

defineAction('adminDeckDelete', {
  tier: 'staff',
  schema: z.object({ id: z.string().min(1) }),
  async handler(input, ctx) {
    const d = await ctx.db.deck.findFirst({
      where: { id: input.id, tenantId: ctx.tenantId },
    });
    if (!d) throw new ActionError('Deck not found');

    for (const key of [d.pdfKey, d.pptxKey]) {
      if (!key) continue;
      try {
        await deleteObject(key);
      } catch {
        // A missing object must not block removing the deck.
      }
    }
    await ctx.db.deck.delete({ where: { id: d.id } });
    await audit(ctx, 'deck_delete', input.id, d.name);
    return { id: input.id };
  },
});
