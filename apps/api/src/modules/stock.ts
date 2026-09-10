import { z } from 'zod';
import { ActionError, defineAction, type ActionContext } from '../lib/dispatch.js';
import { audit } from '../lib/audit.js';
import { getSettings, saveSettings, displayStamp } from '../lib/settings.js';
import { sendMail } from '../lib/mail.js';
import { WIRE_STATUS } from '../lib/orderState.js';
import type { SupplyStatus } from '../generated/prisma/index.js';

const DAY_MS = 86_400_000;
/** Buffer on top of lead time when suggesting a quantity. */
const COVER_DAYS = 30;
/** Trailing window the consumption rate is measured over. */
const CONSUMPTION_DAYS = 90;

/** Days a stage may sit before it is overdue (STAGE_SLA in Analytics.gs). */
const STAGE_SLA: Record<string, number> = {
  New: 2, Accepted: 3, 'PI Sent': 5, 'PI Accepted': 3,
  'PO Received': 7, 'In Production': 21, Dispatched: 10,
};

const FULFIL_STAGES = ['PO Received', 'In Production', 'Dispatched'];

/**
 * Supply status on the wire is the four values the console knows:
 * Planned | Open | Done | Cancelled. Internally there is a fifth, `partial`,
 * for an order part-received -- the Sheets version could not represent that and
 * reported it as Open, so Open is what it still reports.
 */
const SUPPLY_WIRE: Record<SupplyStatus, string> = {
  planned: 'Planned', ordered: 'Open', partial: 'Open',
  received: 'Done', cancelled: 'Cancelled',
};
const SUPPLY_FROM_WIRE: Record<string, SupplyStatus> = {
  Planned: 'planned', Open: 'ordered', Done: 'received', Cancelled: 'cancelled',
};
const OPEN_SUPPLY: SupplyStatus[] = ['planned', 'ordered', 'partial'];

/**
 * Days for the reorder maths, read out of free text.
 *
 * Stock.gs did this by stripping every non-digit, which glues a range together:
 * "3-4 weeks" became the number 34, then 34 days. That is not 3 weeks, not 4
 * weeks, and not deliberate. It read plausibly enough that nobody noticed.
 *
 * Here the numbers are read as numbers and the unit is honoured. A range takes
 * its upper bound, because planning replenishment against the optimistic end of
 * a supplier's own estimate is how you run out.
 *
 *   "21 days"    -> 21        "3-4 weeks" -> 28
 *   "2 months"   -> 60        "21"        -> 21   (days assumed)
 *   "ex-stock"   -> 14        ""          -> 14   (fallback)
 */
const leadDays = (lead: string | null): number => {
  const text = String(lead ?? '').toLowerCase();
  const numbers = text.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (!numbers.length) return 14;
  const value = Math.max(...numbers);
  const unit = /month/.test(text) ? 30 : /week/.test(text) ? 7 : 1;
  const days = value * unit;
  return days > 0 ? Math.round(days) : 14;
};

/** Lot a suggestion rounds up to: batch for made goods, vendor MOQ for bought. */
const lotOf = (p: {
  supplyMode: string | null; batchQty: number | null;
  vendorMoq: number | null; moq: number;
}): number => {
  const lot = p.supplyMode === 'make' ? p.batchQty : p.vendorMoq;
  return lot || p.moq || 1;
};

const modeOf = (p: { supplyMode: string | null }): 'make' | 'buy' =>
  p.supplyMode === 'make' ? 'make' : 'buy';

const atpOf = (p: { onHand: number; reserved: number; safetyStock: number }): number =>
  Math.max(0, p.onHand - p.reserved - p.safetyStock);

const ymd = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : '');

function supplyOut(s: {
  id: string; kind: string; sku: string; name: string; qty: number;
  vendor: string | null; status: SupplyStatus; expected: Date | null;
  externalRef: string | null; note: string | null; createdBy: string | null;
  createdAt: Date; updatedAt: Date; receivedQty: number; receivedAt: Date | null;
}) {
  return {
    id: s.id, kind: s.kind, sku: s.sku, name: s.name, qty: s.qty,
    vendor: s.vendor ?? '', status: SUPPLY_WIRE[s.status], expected: ymd(s.expected),
    ref: s.externalRef ?? '', note: s.note ?? '', created_by: s.createdBy ?? '',
    created: s.createdAt.toISOString(), updated: s.updatedAt.toISOString(),
    received_qty: s.receivedQty,
    received: s.receivedAt ? s.receivedAt.toISOString() : '',
  };
}

// ---------------------------------------------------------------------------

defineAction('adminStock', {
  tier: 'staff',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    const now = Date.now();
    const cutoff = new Date(now - CONSUMPTION_DAYS * DAY_MS);

    const [products, supply, orders, settings] = await Promise.all([
      ctx.db.product.findMany({
        where: { tenantId: ctx.tenantId },
        include: { brand: { select: { code: true } } },
      }),
      ctx.db.supplyOrder.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
      }),
      ctx.db.request.findMany({
        where: { tenantId: ctx.tenantId, status: { in: ['PoReceived', 'InProduction', 'Dispatched'] } },
        include: { lines: true, shipments: true },
      }),
      getSettings(ctx.db, ctx.tenantId),
    ]);

    // Consumption: only real outward movement counts, so a manual correction
    // does not masquerade as demand.
    const outward = await ctx.db.stockLog.findMany({
      where: {
        tenantId: ctx.tenantId,
        delta: { lt: 0 },
        OR: [
          { reason: { startsWith: 'PO received', mode: 'insensitive' } },
          { reason: { startsWith: 'dispatch', mode: 'insensitive' } },
        ],
      },
      select: { sku: true, delta: true, createdAt: true },
    });

    const units = new Map<string, number>();
    const lastOut = new Map<string, number>();
    for (const e of outward) {
      const ts = e.createdAt.getTime();
      const prev = lastOut.get(e.sku);
      if (prev === undefined || ts > prev) lastOut.set(e.sku, ts);
      if (e.createdAt < cutoff) continue;
      units.set(e.sku, (units.get(e.sku) ?? 0) + Math.abs(e.delta));
    }

    // Quantities already on the way, so a suggestion does not double-order.
    const inbound = new Map<string, number>();
    for (const s of supply) {
      if (!OPEN_SUPPLY.includes(s.status)) continue;
      const left = s.qty - s.receivedQty;
      if (left > 0) inbound.set(s.sku, (inbound.get(s.sku) ?? 0) + left);
    }

    const reorder = products
      .map((p) => {
        const atp = atpOf(p);
        const rop = p.reorderPoint;
        const due = atp <= 0 || (rop > 0 && atp <= rop);
        if (!due) return null;

        const rate = (units.get(p.sku) ?? 0) / CONSUMPTION_DAYS;
        const lead = leadDays(p.leadTime);
        const lot = lotOf(p);
        const coming = inbound.get(p.sku) ?? 0;
        const target = Math.ceil(rate * (lead + COVER_DAYS)) + p.safetyStock;
        const gap = target - atp - coming;

        let suggest = 0;
        if (gap > 0) suggest = Math.max(lot, Math.ceil(gap / lot) * lot);
        // Below the point with nothing coming: at least one lot, even when the
        // measured rate is zero (a product that has never moved still needs
        // stock on the shelf to be sellable).
        else if (coming === 0 && rop > 0) suggest = lot;

        return {
          sku: p.sku, name: p.name, brand: p.brand?.code ?? '',
          mode: modeOf(p), vendor: p.vendor ?? '',
          atp, on_hand: p.onHand, reserved: p.reserved,
          reorder_point: rop, safety_stock: p.safetyStock,
          rate_per_day: Math.round(rate * 100) / 100,
          days_cover: rate > 0 ? Math.floor(atp / rate) : null,
          lead_days: lead, lot, inbound: coming,
          target, suggest_qty: suggest,
          covered: gap <= 0 && coming > 0,
          last_out: lastOut.has(p.sku)
            ? new Date(lastOut.get(p.sku)!).toISOString().slice(0, 10)
            : '',
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => {
        const ac = a.days_cover ?? 9999;
        const bc = b.days_cover ?? 9999;
        return (
          (a.atp <= 0 ? 0 : 1) - (b.atp <= 0 ? 0 : 1) || ac - bc || a.atp - b.atp
        );
      });

    const byS = new Map(products.map((p) => [p.sku, p]));
    const queue = orders
      .map((o) => {
        const wire = WIRE_STATUS[o.status];
        const dates = (o.statusDates ?? {}) as Record<string, string>;
        const since = dates[wire]
          ? new Date(dates[wire]!).getTime()
          : o.createdAt.getTime();
        const age = Math.floor((now - since) / DAY_MS);
        const sla = STAGE_SLA[wire] ?? 7;

        let unitCount = 0;
        const short: string[] = [];
        for (const l of o.lines) {
          unitCount += l.qty;
          const p = byS.get(l.sku);
          // Stock was deducted at PO Received, so a negative on-hand means this
          // order was promised units the shelf did not have.
          if (!p) short.push(`${l.sku} (not in catalogue)`);
          else if (p.onHand < 0) short.push(`${l.sku} short by ${Math.abs(p.onHand)}`);
        }
        const shipped = o.shipments.reduce((a, s) => a + s.qty, 0);

        return {
          id: o.ref, company: o.company ?? '', status: wire,
          po_number: o.poNumber ?? '',
          age_days: age, sla_days: sla, overdue: age > sla,
          lines: o.lines.length, units: unitCount, shipped, short,
        };
      })
      .sort(
        (a, b) =>
          Number(b.overdue) - Number(a.overdue) || b.age_days - a.age_days,
      );

    const supplyRows = supply.map(supplyOut);

    return {
      generated_at: displayStamp(),
      measured_over_days: CONSUMPTION_DAYS,
      cover_days: COVER_DAYS,
      reorder,
      queue,
      supply: supplyRows,
      products: products.map((p) => ({
        sku: p.sku, name: p.name, mode: modeOf(p), vendor: p.vendor ?? '',
        lot: lotOf(p), atp: atpOf(p), on_hand: p.onHand,
        lead_days: leadDays(p.leadTime), reorder_point: p.reorderPoint,
        safety_stock: p.safetyStock, vendor_moq: p.vendorMoq ?? 0,
        batch_qty: p.batchQty ?? 0, moq: p.moq,
      })),
      counts: {
        out_of_stock: reorder.filter((r) => r.atp <= 0).length,
        reorder_due: reorder.length,
        covered: reorder.filter((r) => r.covered).length,
        queue: queue.length,
        overdue: queue.filter((r) => r.overdue).length,
        short_orders: queue.filter((r) => r.short.length > 0).length,
        make_open: supplyRows.filter(
          (r) => r.kind === 'make' && ['Planned', 'Open'].includes(r.status),
        ).length,
        buy_open: supplyRows.filter(
          (r) => r.kind === 'buy' && ['Planned', 'Open'].includes(r.status),
        ).length,
        no_reorder_point: products.filter((p) => !p.reorderPoint).length,
        supply_mode_unset: products.filter((p) => !p.supplyMode).length,
      },
      reorder_alert: settings.reorder_alert ?? 'off',
      notify_email: settings.notify_email ?? '',
    };
  },
});

defineAction('adminSupplyFields', {
  tier: 'staff',
  schema: z.object({
    sku: z.string().trim().min(1, 'sku required'),
    supply_mode: z.string().optional(),
    vendor: z.string().optional(),
    vendor_moq: z.coerce.number().int().nonnegative().optional(),
    batch_qty: z.coerce.number().int().nonnegative().optional(),
    reorder_point: z.coerce.number().int().nonnegative().optional(),
    safety_stock: z.coerce.number().int().nonnegative().optional(),
    lead_time: z.string().optional(),
  }),
  async handler(input, ctx) {
    const sku = input.sku.toUpperCase();
    const p = await ctx.db.product.findUnique({
      where: { tenantId_sku: { tenantId: ctx.tenantId, sku } },
    });
    if (!p) throw new ActionError(`Product not found: ${sku}`);

    const mode = String(input.supply_mode ?? '').toLowerCase();
    const supplyMode = mode === 'make' ? 'make' : 'buy';

    await ctx.db.product.update({
      where: { id: p.id },
      data: {
        supplyMode,
        vendor: (input.vendor ?? '').trim() || null,
        vendorMoq: input.vendor_moq ?? null,
        batchQty: input.batch_qty ?? null,
        reorderPoint: input.reorder_point ?? 0,
        safetyStock: input.safety_stock ?? 0,
        leadTime: (input.lead_time ?? '').trim() || null,
      },
    });

    await audit(
      ctx, 'supply_fields', sku,
      supplyMode + (input.vendor ? ` · ${input.vendor}` : ''),
    );
    return { sku };
  },
});

async function nextSupplyRef(ctx: ActionContext): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `SO-${year}-`;
  const last = await ctx.db.supplyOrder.findFirst({
    where: { tenantId: ctx.tenantId, ref: { startsWith: prefix } },
    orderBy: { ref: 'desc' },
    select: { ref: true },
  });
  const n = last ? Number(last.ref.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

defineAction('adminSupplySave', {
  tier: 'staff',
  schema: z.object({
    supply: z.object({
      id: z.string().optional(),
      kind: z.enum(['make', 'buy']).optional(),
      sku: z.string().trim().min(1),
      qty: z.coerce.number().int().positive('Quantity must be above zero'),
      vendor: z.string().optional(),
      status: z.enum(['Planned', 'Open', 'Done', 'Cancelled']).optional(),
      expected: z.string().optional(),
      ref: z.string().optional(),
      note: z.string().optional(),
    }),
  }),
  async handler(input, ctx) {
    const d = input.supply;
    const sku = d.sku.toUpperCase();
    const product = await ctx.db.product.findUnique({
      where: { tenantId_sku: { tenantId: ctx.tenantId, sku } },
    });
    if (!product) throw new ActionError(`Product not found: ${sku}`);

    // The product's own supply_mode decides which plan this lands in, so a
    // made good cannot end up on the purchase list by mistake.
    const kind = d.kind ?? modeOf(product);

    const data = {
      kind,
      productId: product.id,
      sku,
      name: product.name,
      qty: d.qty,
      vendor: (d.vendor ?? '').trim() || product.vendor || null,
      status: d.status ? SUPPLY_FROM_WIRE[d.status]! : ('planned' as SupplyStatus),
      expected: d.expected ? new Date(d.expected) : null,
      externalRef: d.ref ?? null,
      note: d.note ?? null,
    };

    let row;
    if (d.id) {
      const existing = await ctx.db.supplyOrder.findFirst({
        where: { id: d.id, tenantId: ctx.tenantId },
      });
      if (!existing) throw new ActionError('Supply order not found');
      row = await ctx.db.supplyOrder.update({ where: { id: d.id }, data });
    } else {
      row = await ctx.db.supplyOrder.create({
        data: {
          ...data,
          tenantId: ctx.tenantId,
          ref: await nextSupplyRef(ctx),
          createdBy: ctx.actor,
        },
      });
    }

    await audit(ctx, 'supply_save', row.ref, `${sku} × ${d.qty}`);
    return { supply: supplyOut(row) };
  },
});

defineAction('adminSupplyReceive', {
  tier: 'staff',
  schema: z.object({
    id: z.string().min(1),
    qty: z.coerce.number().int().positive('Quantity must be above zero'),
    close: z.boolean().optional(),
  }),
  async handler(input, ctx) {
    const so = await ctx.db.supplyOrder.findFirst({
      where: { id: input.id, tenantId: ctx.tenantId },
    });
    if (!so) throw new ActionError('Supply order not found');
    if (!OPEN_SUPPLY.includes(so.status)) {
      throw new ActionError(`This supply order is ${SUPPLY_WIRE[so.status]}`);
    }

    const product = await ctx.db.product.findUnique({
      where: { id: so.productId },
    });
    if (!product) throw new ActionError(`Product not found: ${so.sku}`);

    // Receiving is the only action in the Stock tab that changes on hand, and
    // it writes a ledger row like every other movement.
    await ctx.db.product.update({
      where: { id: product.id },
      data: { onHand: product.onHand + input.qty },
    });
    await ctx.db.stockLog.create({
      data: {
        tenantId: ctx.tenantId,
        productId: product.id,
        sku: so.sku,
        delta: input.qty,
        reason: `${so.kind === 'make' ? 'production done' : 'supply received'} ${so.ref}`,
        actor: ctx.actor,
      },
    });

    const receivedQty = so.receivedQty + input.qty;
    const status: SupplyStatus =
      receivedQty >= so.qty || input.close
        ? 'received'
        : ('partial' as SupplyStatus);

    const row = await ctx.db.supplyOrder.update({
      where: { id: so.id },
      data: { receivedQty, receivedAt: new Date(), status },
    });

    await audit(
      ctx, 'supply_receive', so.ref,
      `${so.sku} +${input.qty} → ${SUPPLY_WIRE[status]}`,
    );
    return { supply: supplyOut(row) };
  },
});

defineAction('adminSupplyDelete', {
  tier: 'staff',
  schema: z.object({ id: z.string().min(1) }),
  async handler(input, ctx) {
    const so = await ctx.db.supplyOrder.findFirst({
      where: { id: input.id, tenantId: ctx.tenantId },
    });
    if (!so) throw new ActionError('Supply order not found');
    if (so.receivedQty > 0) {
      // Deleting it would strand the ledger rows its receipts already wrote.
      throw new ActionError(
        'Stock has already been received against this order — cancel it instead',
      );
    }
    await ctx.db.supplyOrder.delete({ where: { id: so.id } });
    await audit(ctx, 'supply_delete', so.ref, so.sku);
    return { id: input.id };
  },
});

defineAction('adminStockAlert', {
  tier: 'staff',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    const settings = await getSettings(ctx.db, ctx.tenantId);
    const to = (settings.notify_email ?? '').trim();
    if (!to) throw new ActionError('Set a notification address in Settings first');

    // Built from the same view the Stock tab shows, so the digest and the
    // screen can never disagree about what needs ordering.
    const products = await ctx.db.product.findMany({ where: { tenantId: ctx.tenantId } });
    const supply = await ctx.db.supplyOrder.findMany({
      where: { tenantId: ctx.tenantId, status: { in: OPEN_SUPPLY } },
    });
    const inbound = new Map<string, number>();
    for (const s of supply) {
      const left = s.qty - s.receivedQty;
      if (left > 0) inbound.set(s.sku, (inbound.get(s.sku) ?? 0) + left);
    }

    const due = products
      .filter((p) => {
        const atp = atpOf(p);
        return atp <= 0 || (p.reorderPoint > 0 && atp <= p.reorderPoint);
      })
      .sort((a, b) => atpOf(a) - atpOf(b));

    if (!due.length) {
      await audit(ctx, 'stock_alert', to, 'nothing below the reorder point');
      return { sent: false, to, nothing_due: true };
    }

    const body =
      `${due.length} product${due.length === 1 ? '' : 's'} at or below the reorder point ` +
      `as at ${displayStamp()}.\n\n` +
      due
        .map((p) => {
          const atp = atpOf(p);
          const coming = inbound.get(p.sku) ?? 0;
          return (
            `${p.sku}  ${p.name}\n` +
            `   available ${atp} · reorder point ${p.reorderPoint} · lot ${lotOf(p)}` +
            `${coming ? ` · ${coming} already on order` : ''}` +
            `${p.vendor ? ` · ${p.vendor}` : ''}`
          );
        })
        .join('\n\n') +
      `\n\nOpen the Stock tab to raise the supply orders.`;

    const res = await sendMail(ctx.db, ctx.tenantId, {
      to,
      subject: `[${settings.co_name || settings.site_name || 'Merchforce'}] Reorder due — ${due.length} product${due.length === 1 ? '' : 's'}`,
      text: body,
    });
    await audit(ctx, 'stock_alert', to, res.ok ? `sent via ${res.via}` : `failed: ${res.error}`);
    return { sent: res.ok, to, count: due.length, ...(res.error ? { error: res.error } : {}) };
  },
});

defineAction('adminStockSchedule', {
  tier: 'staff',
  schema: z.object({ mode: z.enum(['off', 'daily']) }),
  async handler(input, ctx) {
    await saveSettings(ctx.db, ctx.tenantId, { reorder_alert: input.mode });
    await audit(ctx, 'stock_schedule', undefined, input.mode);
    return { reorder_alert: input.mode };
  },
});
