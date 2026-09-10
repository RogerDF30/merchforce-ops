import { env } from '../env.js';
import { notify } from './mail.js';
import { getSettings } from './settings.js';
import { presignGet } from './storage.js';
import type { ActionContext } from './dispatch.js';

/**
 * Every notification the app sends, ported from Requests.gs, Orders.gs,
 * Decks.gs and Stock.gs.
 *
 * All of them are best effort: a bounced confirmation does not un-confirm an
 * order. Failures land in the audit log as mail_fail (see notify()).
 */

const money = (n: number): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The customer's own order page, if a public URL is configured. */
function orderLink(token: string): string {
  const base = env.PUBLIC_ORDER_URL.trim();
  return base && token ? `${base}?t=${token}` : '';
}

interface Req {
  ref: string;
  company: string | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
  token: string;
  piNumber: string | null;
  piKey: string | null;
  piTotal: unknown;
  piValidTill: Date | null;
  poNumber: string | null;
  poKey: string | null;
  totalEst: unknown;
  notes: string | null;
}

const linesText = (lines: { sku: string; name: string; qty: number; unitPrice: unknown }[]): string =>
  lines
    .map((l) => `${l.sku}  ${l.name}  x${l.qty}  @${money(Number(l.unitPrice))}`)
    .join('\n');

async function supplierMail(ctx: ActionContext): Promise<string> {
  const s = await getSettings(ctx.db, ctx.tenantId);
  return (s.notify_email || s.co_email || '').trim();
}

async function brandName(ctx: ActionContext): Promise<string> {
  const s = await getSettings(ctx.db, ctx.tenantId);
  return s.co_name || s.site_name || 'Merchforce';
}

async function tag(ctx: ActionContext): Promise<string> {
  const s = await getSettings(ctx.db, ctx.tenantId);
  return s.site_name || 'Merchforce';
}

// ---------------------------------------------------------------------------

export async function notifyNewRequest(
  ctx: ActionContext,
  r: Req,
  lines: { sku: string; name: string; qty: number; unitPrice: unknown }[],
  total: number,
): Promise<void> {
  const to = await supplierMail(ctx);
  if (!to) return;
  await notify(ctx.db, ctx.tenantId, ctx.actor, {
    to,
    subject: `[${await tag(ctx)}] New enquiry ${r.ref} — ${r.company ?? ''}`,
    text:
      `New request ${r.ref} from ${r.company ?? ''} (${r.contact ?? ''}, ${r.email ?? ''}` +
      `${r.phone ? `, ${r.phone}` : ''})\n` +
      `Raised in the console by ${ctx.actor}\n\n` +
      `${linesText(lines)}\n\n` +
      `Estimated total: ${money(total)}\nNotes: ${r.notes || '-'}\n\n` +
      `Open the admin console to review.`,
    ...(r.email ? { replyTo: r.email } : {}),
  });
}

export async function notifyAssigned(
  ctx: ActionContext,
  r: { ref: string; company: string | null },
  status: string,
  to: string,
): Promise<void> {
  // Assigning something to yourself does not need an email about it.
  if (!to || to === ctx.actorEmail.toLowerCase()) return;
  await notify(ctx.db, ctx.tenantId, ctx.actor, {
    to,
    subject: `[${await brandName(ctx)}] ${r.ref} assigned to you`,
    text:
      `${ctx.actor} assigned enquiry ${r.ref} (${r.company ?? ''} · ${status}) to you for follow-up.\n\n` +
      `Open the console and look under My enquiries.`,
  });
}

export async function notifyDecision(
  ctx: ActionContext,
  r: Req,
  accepted: boolean,
  note?: string,
): Promise<void> {
  if (!r.email) return;
  const link = orderLink(r.token);
  await notify(ctx.db, ctx.tenantId, ctx.actor, {
    to: r.email,
    subject: `[${await tag(ctx)}] ${r.ref} — ${accepted ? 'request accepted' : 'request update'}`,
    text:
      `Hello ${r.contact ?? ''},\n\n` +
      (accepted
        ? `We have accepted your request ${r.ref} and are preparing your proforma invoice.\n`
        : `We are unable to take up request ${r.ref} at this time.\n`) +
      (note ? `\n${note}\n` : '') +
      (accepted && link ? `\nFollow it here: ${link}\n` : '') +
      `\n${await brandName(ctx)}`,
    ...((await supplierMail(ctx)) ? { replyTo: await supplierMail(ctx) } : {}),
  });
}

export async function notifyPiSent(
  ctx: ActionContext,
  r: Req,
  lines: { sku: string; name: string; qty: number; unitPrice: unknown }[],
): Promise<void> {
  if (!r.email) return;
  const link = orderLink(r.token);
  // A fresh signed link, valid a fortnight -- long enough to act on, short
  // enough that a forwarded email stops working.
  const piUrl = r.piKey ? await presignGet(r.piKey, 14 * 24 * 3600) : '';
  await notify(ctx.db, ctx.tenantId, ctx.actor, {
    to: r.email,
    subject: `[${await tag(ctx)}] Proforma invoice ${r.piNumber ?? ''} for ${r.ref}`,
    text:
      `Hello ${r.contact ?? ''},\n\n` +
      `Your proforma invoice for ${r.ref} is ready.\n\n` +
      `PI number: ${r.piNumber ?? ''}\n` +
      `Total: ₹${money(Number(r.piTotal ?? 0))}\n` +
      (r.piValidTill
        ? `Valid till: ${r.piValidTill.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}\n`
        : '') +
      `\n${linesText(lines)}\n\n` +
      (piUrl ? `Download the PI: ${piUrl}\n\n` : '') +
      (link ? `Accept it, decline it, or send us your purchase order here:\n${link}\n\n` : '') +
      `Stock is held for you only once the proforma is accepted.\n\n` +
      (await brandName(ctx)),
    ...((await supplierMail(ctx)) ? { replyTo: await supplierMail(ctx) } : {}),
  });
}

export async function notifyPiDecision(
  ctx: ActionContext,
  r: Req,
  accepted: boolean,
  note?: string,
): Promise<void> {
  const to = await supplierMail(ctx);
  if (!to) return;
  await notify(ctx.db, ctx.tenantId, ctx.actor, {
    to,
    subject:
      `[${await tag(ctx)}] ${r.ref} — proforma ${accepted ? 'ACCEPTED' : 'declined'} by ${r.company ?? ''}`,
    text:
      `${r.company ?? ''} has ${accepted ? 'accepted' : 'declined'} proforma ${r.piNumber ?? ''}.\n\n` +
      (accepted
        ? `Stock is now held for this order. The purchase order is the next step — the client can upload it from their order page, or you can add it in the admin console.\n`
        : `No stock has been held.\n`) +
      (note ? `\nTheir note: ${note}\n` : '') +
      `\nOrder total: ₹${money(Number(r.piTotal ?? r.totalEst ?? 0))}\n`,
    ...(r.email ? { replyTo: r.email } : {}),
  });
}

export async function notifyPoReceived(
  ctx: ActionContext,
  r: Req,
  who: 'client' | 'admin',
): Promise<void> {
  const to = await supplierMail(ctx);
  const poUrl = r.poKey ? await presignGet(r.poKey, 14 * 24 * 3600) : '';
  if (to) {
    await notify(ctx.db, ctx.tenantId, ctx.actor, {
      to,
      subject: `[${await tag(ctx)}] ${r.ref} — purchase order received`,
      text:
        (who === 'client'
          ? `${r.company ?? ''} has uploaded their purchase order.`
          : `A purchase order was added for ${r.company ?? ''}.`) +
        `\n\n` +
        (r.poNumber ? `PO number: ${r.poNumber}\n` : '') +
        (poUrl ? `Download: ${poUrl}\n` : '') +
        `\nStock has been deducted for this order. It is now in production.\n`,
      ...(r.email ? { replyTo: r.email } : {}),
    });
  }
  if (!r.email) return;
  const link = orderLink(r.token);
  await notify(ctx.db, ctx.tenantId, ctx.actor, {
    to: r.email,
    subject: `[${await tag(ctx)}] Order confirmed — ${r.ref}`,
    text:
      `Hello ${r.contact ?? ''},\n\nWe have your purchase order` +
      (r.poNumber ? ` (${r.poNumber})` : '') +
      ` and your order is confirmed.\n\n` +
      `We will send tracking details as the goods ship.\n` +
      (link ? `\nTrack it any time: ${link}\n` : '') +
      `\n${await brandName(ctx)}`,
    ...(to ? { replyTo: to } : {}),
  });
}

export async function notifyShipment(
  ctx: ActionContext,
  r: Req,
  sh: {
    shipmentNo: number; qty: number; carrier: string | null;
    tracking: string | null; note: string | null; status: string;
  },
): Promise<void> {
  if (!r.email) return;
  const delivered = sh.status === 'delivered';
  const link = orderLink(r.token);
  await notify(ctx.db, ctx.tenantId, ctx.actor, {
    to: r.email,
    subject:
      `[${await tag(ctx)}] ${r.ref} — ` +
      (delivered ? 'delivered' : `shipment ${sh.shipmentNo} dispatched`),
    text:
      `Hello ${r.contact ?? ''},\n\n` +
      (delivered
        ? `Shipment ${sh.shipmentNo} of order ${r.ref} has been delivered.\n`
        : `Shipment ${sh.shipmentNo} of order ${r.ref} is on its way.\n`) +
      (sh.qty ? `\nQuantity: ${sh.qty}` : '') +
      (sh.carrier ? `\nCarrier: ${sh.carrier}` : '') +
      (sh.tracking ? `\nTracking: ${sh.tracking}` : '') +
      (sh.note ? `\nNote: ${sh.note}` : '') +
      (link ? `\n\nFull order status: ${link}\n` : '') +
      `\n${await brandName(ctx)}`,
    ...((await supplierMail(ctx)) ? { replyTo: await supplierMail(ctx) } : {}),
  });
}
