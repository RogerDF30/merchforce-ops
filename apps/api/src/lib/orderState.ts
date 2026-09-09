import { ActionError } from './dispatch.js';
import type { ActionContext } from './dispatch.js';
import type { RequestStatus, StockState } from '../generated/prisma/index.js';

/**
 * The order lifecycle, and the single place stock moves.
 *
 * In the Apps Script version there were two ways to change a status.
 * setStatus_ ran the stock machine; fnAdminRequestUpdate_ -- which is what the
 * console's own status dropdown calls (admin.js:1017) -- wrote the status
 * straight to the row and never called it. Its only stock branches tested for
 * a status called 'Confirmed', which the supplier fork removed, so they could
 * never fire. The result was that moving an order to PO Received from the
 * dropdown advanced the order without ever deducting stock.
 *
 * So there is exactly one entry point here, and every caller goes through it.
 */

export const FORWARD: RequestStatus[] = [
  'New', 'Accepted', 'PiSent', 'PiAccepted', 'PoReceived',
  'InProduction', 'Dispatched', 'Delivered', 'Closed',
];

export const TERMINAL: RequestStatus[] = [
  'Rejected', 'Declined', 'Expired', 'Cancelled',
];

/** Wire spellings, which carry spaces. */
export const WIRE_STATUS: Record<RequestStatus, string> = {
  New: 'New', Accepted: 'Accepted', PiSent: 'PI Sent', PiAccepted: 'PI Accepted',
  PoReceived: 'PO Received', InProduction: 'In Production',
  Dispatched: 'Dispatched', Delivered: 'Delivered', Closed: 'Closed',
  Rejected: 'Rejected', Declined: 'Declined', Expired: 'Expired',
  Cancelled: 'Cancelled',
};

const FROM_WIRE = new Map<string, RequestStatus>(
  Object.entries(WIRE_STATUS).map(([k, v]) => [v, k as RequestStatus]),
);

export function parseStatus(v: unknown): RequestStatus {
  const s = FROM_WIRE.get(String(v ?? ''));
  if (!s) throw new ActionError(`Bad status: ${String(v)}`);
  return s;
}

/**
 * What the stock should be for a given status. null means "leave it alone" --
 * New, Accepted and PI Sent do not touch stock, because nothing has been
 * promised yet.
 */
export function stockStateFor(status: RequestStatus): StockState | null {
  if (status === 'PiAccepted') return 'reserved';
  if (
    status === 'PoReceived' || status === 'InProduction' ||
    status === 'Dispatched' || status === 'Delivered' || status === 'Closed'
  ) {
    return 'deducted';
  }
  if (TERMINAL.includes(status)) return 'none';
  return null;
}

interface Line {
  sku: string;
  qty: number;
  productId: string | null;
}

/**
 * Move stock to `target`. Runs inside the request's transaction, so the ATP
 * re-check and the write that acts on it cannot interleave with another order
 * -- which is what the Apps Script version needed an explicit LockService for.
 */
export async function moveStock(
  ctx: ActionContext,
  requestRef: string,
  lines: Line[],
  current: StockState,
  target: StockState,
): Promise<void> {
  if (current === target) return;

  const productIds = lines.map((l) => l.productId).filter((x): x is string => !!x);
  const products = await ctx.db.product.findMany({
    where: { tenantId: ctx.tenantId, id: { in: productIds } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const reserve = async (sign: 1 | -1, reason: string): Promise<void> => {
    for (const l of lines) {
      if (!l.productId) continue;
      const p = byId.get(l.productId);
      if (!p) continue;
      await ctx.db.product.update({
        where: { id: p.id },
        data: { reserved: Math.max(0, p.reserved + sign * l.qty) },
      });
      await ctx.db.stockLog.create({
        data: {
          tenantId: ctx.tenantId,
          productId: p.id,
          sku: l.sku,
          // On hand does not move on a reservation -- only availability does.
          delta: 0,
          reason: `${reason} (reserved ${sign > 0 ? '+' : '-'}${l.qty})`,
          actor: ctx.actor,
        },
      });
    }
  };

  const dispatch = async (reason: string): Promise<void> => {
    for (const l of lines) {
      if (!l.productId) continue;
      const p = byId.get(l.productId);
      if (!p) continue;
      await ctx.db.product.update({
        where: { id: p.id },
        data: {
          onHand: p.onHand - l.qty,
          reserved: Math.max(0, p.reserved - l.qty),
        },
      });
      await ctx.db.stockLog.create({
        data: {
          tenantId: ctx.tenantId,
          productId: p.id,
          sku: l.sku,
          delta: -l.qty,
          reason,
          actor: ctx.actor,
        },
      });
    }
  };

  const assertAvailable = (): void => {
    const short: string[] = [];
    for (const l of lines) {
      const p = l.productId ? byId.get(l.productId) : undefined;
      const available = p ? Math.max(0, p.onHand - p.reserved - p.safetyStock) : 0;
      if (!p || available < l.qty) {
        short.push(`${l.sku} (need ${l.qty}, available ${available})`);
      }
    }
    if (short.length) {
      throw new ActionError(
        `Not enough stock to hold for this order: ${short.join(', ')}`,
      );
    }
  };

  if (target === 'reserved' && current === 'none') {
    assertAvailable();
    await reserve(1, `PI accepted ${requestRef}`);
  } else if (target === 'deducted' && current === 'reserved') {
    await dispatch(`PO received ${requestRef}`);
  } else if (target === 'deducted' && current === 'none') {
    // Straight to PO without a reservation: check availability, then take it.
    assertAvailable();
    await dispatch(`PO received ${requestRef}`);
  } else if (target === 'none' && current === 'reserved') {
    await reserve(-1, `released ${requestRef}`);
  } else if (target === 'none' && current === 'deducted') {
    throw new ActionError(
      'Stock was already deducted for this order — adjust it in the catalog instead',
    );
  }
}

/**
 * The one way an order's status changes. Applies the stock move first, so a
 * status never advances on an order the stock cannot support.
 */
export async function setStatus(
  ctx: ActionContext,
  requestId: string,
  status: RequestStatus,
  note?: string,
): Promise<{ status: RequestStatus }> {
  const req = await ctx.db.request.findFirst({
    where: { id: requestId, tenantId: ctx.tenantId },
    include: {
      lines: { select: { sku: true, qty: true, productId: true } },
    },
  });
  if (!req) throw new ActionError('Request not found');
  if (req.status === status) return { status };

  const want = stockStateFor(status);
  let nextStockState = req.stockState;
  if (want !== null) {
    await moveStock(ctx, req.ref, req.lines, req.stockState, want);
    nextStockState = want;
  }

  const dates =
    req.statusDates && typeof req.statusDates === 'object'
      ? { ...(req.statusDates as Record<string, string>) }
      : {};
  dates[WIRE_STATUS[status]] = new Date().toISOString();

  await ctx.db.request.update({
    where: { id: requestId },
    data: { status, stockState: nextStockState, statusDates: dates },
  });

  await ctx.db.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      action: 'order_status',
      ref: req.ref,
      detail:
        `${WIRE_STATUS[req.status]} → ${WIRE_STATUS[status]}` +
        (note ? ` · ${note}` : ''),
      ip: ctx.ip || null,
    },
  });

  return { status };
}

/** MF-2026-0001, unique per tenant. */
export async function nextRef(ctx: ActionContext): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `MF-${year}-`;
  const last = await ctx.db.request.findFirst({
    where: { tenantId: ctx.tenantId, ref: { startsWith: prefix } },
    orderBy: { ref: 'desc' },
    select: { ref: true },
  });
  const n = last ? Number(last.ref.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, '0')}`;
}
