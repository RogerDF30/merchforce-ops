import { z } from 'zod';
import { ActionError, defineAction, type ActionContext } from '../lib/dispatch.js';
import { audit } from '../lib/audit.js';
import { getSettings, displayStamp } from '../lib/settings.js';
import { sendMail } from '../lib/mail.js';
import { WIRE_STATUS } from '../lib/orderState.js';

const DAY_MS = 86_400_000;

const OPEN_STAGES = [
  'New', 'Accepted', 'PI Sent', 'PI Accepted',
  'PO Received', 'In Production', 'Dispatched',
];

/** Days a stage may sit before it is flagged as ageing. */
const STAGE_SLA: Record<string, number> = {
  New: 2, Accepted: 3, 'PI Sent': 5, 'PI Accepted': 3,
  'PO Received': 7, 'In Production': 21, Dispatched: 10,
};

const SHIPPED = new Set([
  'PO Received', 'In Production', 'Dispatched', 'Delivered', 'Closed',
]);

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return Math.round(m * 10) / 10;
}

const leadDays = (lead: string | null): number => {
  const text = String(lead ?? '').toLowerCase();
  const numbers = text.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (!numbers.length) return 14;
  const unit = /month/.test(text) ? 30 : /week/.test(text) ? 7 : 1;
  return Math.round(Math.max(...numbers) * unit) || 14;
};

defineAction('adminAnalytics', {
  tier: 'staff',
  schema: z.object({ days: z.coerce.number().optional() }),
  async handler(input, ctx) {
    const days = [30, 90, 180, 365].includes(input.days ?? 0) ? input.days! : 90;
    const now = Date.now();
    const cutoff = new Date(now - days * DAY_MS);

    const [products, requests, lines, outward] = await Promise.all([
      ctx.db.product.findMany({
        where: { tenantId: ctx.tenantId },
        include: { brand: { select: { code: true } } },
      }),
      ctx.db.request.findMany({ where: { tenantId: ctx.tenantId } }),
      ctx.db.requestLine.findMany({ where: { tenantId: ctx.tenantId } }),
      ctx.db.stockLog.findMany({
        where: {
          tenantId: ctx.tenantId,
          delta: { lt: 0 },
          OR: [
            { reason: { startsWith: 'PO received', mode: 'insensitive' } },
            { reason: { startsWith: 'dispatch', mode: 'insensitive' } },
          ],
        },
        select: { sku: true, delta: true, createdAt: true },
      }),
    ]);

    const inWin = requests.filter((r) => r.createdAt >= cutoff);
    const wire = (s: (typeof requests)[number]['status']): string => WIRE_STATUS[s];

    // ---- requests
    const byStatus: Record<string, number> = {};
    let reqValue = 0;
    for (const r of inWin) {
      const w = wire(r.status);
      byStatus[w] = (byStatus[w] ?? 0) + 1;
      reqValue += Number(r.totalEst);
    }

    // ---- weekly trend, weeks starting Monday
    const weeks = new Map<string, { requests: number; value: number }>();
    for (const r of inWin) {
      const d = r.createdAt;
      const monday = new Date(d.getTime() - ((d.getDay() + 6) % 7) * DAY_MS);
      const key = monday.toISOString().slice(0, 10);
      const w = weeks.get(key) ?? { requests: 0, value: 0 };
      w.requests++;
      w.value += Number(r.totalEst);
      weeks.set(key, w);
    }

    // ---- pipeline
    const stages: Record<string, { count: number; value: number; ageing: number }> = {};
    for (const s of OPEN_STAGES) stages[s] = { count: 0, value: 0, ageing: 0 };
    const ageing: Record<string, unknown>[] = [];
    let openCount = 0;
    let openValue = 0;

    for (const r of requests) {
      const w = wire(r.status);
      const stage = stages[w];
      if (!stage) continue;
      const dates = (r.statusDates ?? {}) as Record<string, string>;
      const since = dates[w] ? new Date(dates[w]!).getTime() : r.createdAt.getTime();
      const ageDays = Math.floor((now - since) / DAY_MS);
      const val = r.piTotal ? Number(r.piTotal) : Number(r.totalEst);

      stage.count++;
      stage.value += val;
      openCount++;
      openValue += val;

      const sla = STAGE_SLA[w] ?? 7;
      if (ageDays > sla) {
        stage.ageing++;
        ageing.push({
          id: r.ref, company: r.company ?? '', status: w,
          days_in_stage: ageDays, sla, value: Math.round(val),
        });
      }
    }
    ageing.sort(
      (a, b) =>
        ((b.days_in_stage as number) - (b.sla as number)) -
        ((a.days_in_stage as number) - (a.sla as number)),
    );

    // ---- decisions
    const toPi: number[] = [];
    const toDeliver: number[] = [];
    let accepted = 0, declined = 0, awaiting = 0, awaitingOld = 0;
    for (const r of inWin) {
      const dates = (r.statusDates ?? {}) as Record<string, string>;
      const created = r.createdAt.getTime();
      if (dates['PI Sent']) {
        toPi.push((new Date(dates['PI Sent']!).getTime() - created) / 3_600_000);
      }
      if (dates.Delivered) {
        toDeliver.push((new Date(dates.Delivered).getTime() - created) / DAY_MS);
      }
      if (dates['PI Accepted']) accepted++;
      if (r.status === 'Declined') declined++;
      if (r.status === 'New') {
        awaiting++;
        if (now - created > 2 * DAY_MS) awaitingOld++;
      }
    }
    const decided = accepted + declined;

    // ---- products
    const reqById = new Map(requests.map((r) => [r.id, r]));
    const everRequested = new Set<string>();
    const units = new Map<string, number>();
    const lineValue = new Map<string, number>();
    const shippedUnits = new Map<string, number>();

    for (const l of lines) {
      everRequested.add(l.sku);
      const r = reqById.get(l.requestId);
      if (!r || r.createdAt < cutoff) continue;
      units.set(l.sku, (units.get(l.sku) ?? 0) + l.qty);
      lineValue.set(l.sku, (lineValue.get(l.sku) ?? 0) + Number(l.lineTotal));
      if (SHIPPED.has(wire(r.status))) {
        shippedUnits.set(l.sku, (shippedUnits.get(l.sku) ?? 0) + l.qty);
      }
    }

    const names = new Map(products.map((p) => [p.sku, p.name]));
    const top = (m: Map<string, number>) =>
      [...m.entries()]
        .map(([sku, value]) => ({ sku, name: names.get(sku) ?? sku, value: Math.round(value) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8);

    const never = products
      .filter((p) => !everRequested.has(p.sku))
      .map((p) => ({
        sku: p.sku, name: p.name, category: p.category ?? '', on_hand: p.onHand,
      }));

    // ---- customers
    const byCo = new Map<string, { company: string; requests: number; value: number }>();
    let coTotal = 0;
    for (const r of inWin) {
      const key = (r.company ?? 'Unnamed').trim() || 'Unnamed';
      const v = r.piTotal ? Number(r.piTotal) : Number(r.totalEst);
      const c = byCo.get(key) ?? { company: key, requests: 0, value: 0 };
      c.requests++;
      c.value += v;
      byCo.set(key, c);
      coTotal += v;
    }
    const custList = [...byCo.values()]
      .sort((a, b) => b.value - a.value)
      .map((c) => ({
        ...c,
        value: Math.round(c.value),
        share: coTotal ? Math.round((c.value / coTotal) * 100) : 0,
      }));
    const top3 = custList.slice(0, 3).reduce((a, c) => a + c.value, 0);

    // ---- stock signals. Consumption is only what actually left the building:
    // StockLog also carries manual corrections, which restate a count rather
    // than record a sale, and counting those as demand inflates everything here.
    const consumed = new Map<string, number>();
    const lastOut = new Map<string, number>();
    for (const e of outward) {
      const ts = e.createdAt.getTime();
      if (!lastOut.has(e.sku) || ts > lastOut.get(e.sku)!) lastOut.set(e.sku, ts);
      if (e.createdAt < cutoff) continue;
      consumed.set(e.sku, (consumed.get(e.sku) ?? 0) + Math.abs(e.delta));
    }

    // ABC by value contribution over the same window: A covers the first 80%.
    const ranked = [...lineValue.entries()].sort((a, b) => b[1] - a[1]);
    const totalValue = ranked.reduce((a, [, v]) => a + v, 0);
    const abc = new Map<string, 'A' | 'B' | 'C'>();
    let run = 0;
    for (const [sku, v] of ranked) {
      run += v;
      const pct = totalValue ? run / totalValue : 1;
      abc.set(sku, pct <= 0.8 ? 'A' : pct <= 0.95 ? 'B' : 'C');
    }

    const reorder: Record<string, unknown>[] = [];
    const dead: Record<string, unknown>[] = [];
    let outOfStock = 0, belowRop = 0, unitsOnHand = 0;

    for (const p of products) {
      const atp = Math.max(0, p.onHand - p.reserved - p.safetyStock);
      unitsOnHand += p.onHand;
      const rate = (consumed.get(p.sku) ?? 0) / days;
      const cover = rate > 0 ? Math.floor(atp / rate) : null;
      if (atp <= 0) outOfStock++;
      if (p.reorderPoint > 0 && atp <= p.reorderPoint) belowRop++;

      if (atp <= 0 || (p.reorderPoint > 0 && atp <= p.reorderPoint)) {
        const moq = p.moq || 1;
        const target = Math.ceil(rate * (leadDays(p.leadTime) + 30));
        const need = Math.max(moq, Math.ceil(Math.max(target - atp, moq) / moq) * moq);
        reorder.push({
          sku: p.sku, name: p.name, brand: p.brand?.code ?? '',
          atp, reorder_point: p.reorderPoint, on_hand: p.onHand,
          rate_per_day: Math.round(rate * 100) / 100,
          days_cover: cover, lead_time: p.leadTime ?? '',
          suggest_qty: need, abc: abc.get(p.sku) ?? 'C',
        });
      }

      if (p.onHand > 0 && !consumed.has(p.sku)) {
        const last = lastOut.get(p.sku);
        dead.push({
          sku: p.sku, name: p.name, on_hand: p.onHand,
          last_dispatch: last ? new Date(last).toISOString().slice(0, 10) : 'never',
          days_idle: last ? Math.floor((now - last) / DAY_MS) : null,
        });
      }
    }

    reorder.sort((a, b) => {
      const ac = (a.days_cover as number | null) ?? 9999;
      const bc = (b.days_cover as number | null) ?? 9999;
      return (
        ac - bc ||
        ((a.atp as number) - (a.reorder_point as number)) -
          ((b.atp as number) - (b.reorder_point as number))
      );
    });
    dead.sort((a, b) => (b.on_hand as number) - (a.on_hand as number));

    const abcCount = { A: 0, B: 0, C: 0 };
    for (const v of abc.values()) abcCount[v]++;

    return {
      generated_at: displayStamp(),
      days,
      basis: 'orders and stock movement',
      requests: {
        count: inWin.length,
        value: Math.round(reqValue),
        average: inWin.length ? Math.round(reqValue / inWin.length) : 0,
        by_status: byStatus,
      },
      trend: [...weeks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => ({
          week: new Date(k).toLocaleDateString('en-IN', {
            day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
          }),
          requests: v.requests,
          value: Math.round(v.value),
        })),
      pipeline: {
        stages,
        open_count: openCount,
        open_value: Math.round(openValue),
        ageing: ageing.slice(0, 20),
        ageing_total: ageing.length,
      },
      decision: {
        pi_accepted: accepted,
        pi_declined: declined,
        pi_win_rate: decided ? Math.round((accepted / decided) * 100) : null,
        median_hours_to_pi: median(toPi),
        median_days_to_deliver: median(toDeliver),
        awaiting_decision: awaiting,
        awaiting_over_2_days: awaitingOld,
      },
      products: {
        top_by_units: top(units),
        top_by_value: top(lineValue),
        top_by_shipped: top(shippedUnits),
        never_requested: never.slice(0, 25),
        never_requested_total: never.length,
        catalogue_size: products.filter((p) => p.visible).length,
      },
      customers: {
        count: custList.length,
        top: custList.slice(0, 10),
        top3_share: coTotal ? Math.round((top3 / coTotal) * 100) : null,
      },
      stock: {
        measured_over_days: days,
        out_of_stock: outOfStock,
        below_reorder_point: belowRop,
        units_on_hand: unitsOnHand,
        reorder: reorder.slice(0, 30),
        reorder_total: reorder.length,
        dead: dead.slice(0, 25),
        dead_total: dead.length,
        abc: abcCount,
        no_reorder_point: products.filter((p) => !p.reorderPoint).length,
      },
    };
  },
});

defineAction('adminMailTest', {
  tier: 'admin',
  schema: z.object({ to: z.string().optional() }),
  async handler(input, ctx) {
    const settings = await getSettings(ctx.db, ctx.tenantId);
    const to = (input.to ?? settings.notify_email ?? '').trim();
    if (!to) throw new ActionError('Set a notification address in Settings first');
    const res = await sendMail(ctx.db, ctx.tenantId, {
      to,
      subject: `[${settings.co_name || settings.site_name || 'Merchforce'}] Test message`,
      text:
        `This is a test from your Merchforce console.\n\n` +
        `If it reached you, notifications to customers will too.\n\n` +
        `Sent ${displayStamp()}.`,
    });
    await audit(ctx, 'mail_test', to, res.ok ? `sent via ${res.via}` : `failed: ${res.error}`);

    // The from address is reported either way: the usual reason a send fails is
    // that it went out on a domain Resend has not verified for this supplier,
    // and seeing the address is what makes that obvious.
    return { sent: res.ok, to, from: res.from, via: res.via, ...(res.error ? { error: res.error } : {}) };
  },
});
