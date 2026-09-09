import { z } from 'zod';
import { Prisma } from '../generated/prisma/index.js';
import { ActionError, defineAction, type ActionContext } from '../lib/dispatch.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { addressText, stateCodeOf } from '../lib/gst.js';
import { buildKey, presignGet, putObject } from '../lib/storage.js';
import { htmlToPdf } from '../lib/pdf.js';
import { piHtml, piTotal, type PiLine } from '../lib/piHtml.js';
import { setStatus, WIRE_STATUS } from '../lib/orderState.js';

const MAX_DOC_BYTES = 10 * 1024 * 1024;

function decodeUpload(data: string, label: string): Buffer {
  const b64 = data.replace(/^data:[^;]+;base64,/, '');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) throw new ActionError(`${label} is empty or not valid base64`);
  if (bytes.length > MAX_DOC_BYTES) throw new ActionError('File over 10MB');
  return bytes;
}

async function findByRef(ctx: ActionContext, ref: string) {
  const r = await ctx.db.request.findUnique({
    where: { tenantId_ref: { tenantId: ctx.tenantId, ref } },
    include: { lines: true, companyRef: true },
  });
  if (!r) throw new ActionError('Request not found');
  return r;
}

/** PI-2026-0001, sequential per tenant. */
async function nextPiNumber(ctx: ActionContext, prefix: string): Promise<string> {
  const year = new Date().getFullYear();
  const head = `${prefix}-${year}-`;
  const last = await ctx.db.request.findFirst({
    where: { tenantId: ctx.tenantId, piNumber: { startsWith: head } },
    orderBy: { piNumber: 'desc' },
    select: { piNumber: true },
  });
  const n = last?.piNumber ? Number(last.piNumber.slice(head.length)) + 1 : 1;
  return `${head}${String(n).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------

defineAction('adminPiBuild', {
  tier: 'staff',
  schema: z.object({
    id: z.string().min(1),
    lines: z
      .array(
        z.object({
          sku: z.string().min(1),
          name: z.string().optional(),
          qty: z.coerce.number().int().nonnegative(),
          unit_price: z.coerce.number().nonnegative(),
          gst: z.coerce.number().nonnegative().optional(),
          hsn: z.string().optional(),
        }),
      )
      .min(1, 'The quotation needs at least one line'),
    freight: z.coerce.number().nonnegative().optional(),
    discount: z.coerce.number().nonnegative().optional(),
    notes: z.string().optional(),
    validity_days: z.coerce.number().int().positive().optional(),
    place_of_supply: z.string().optional(),
    ship_address: z.string().optional(),
    send: z.boolean().optional(),
  }),
  async handler(input, ctx) {
    const req = await findByRef(ctx, input.id);
    const settings = await getSettings(ctx.db, ctx.tenantId);

    const existing = new Map(req.lines.map((l) => [l.sku.toUpperCase(), l]));

    // The PI governs from here, so the order lines are rewritten at the
    // negotiated prices. list_price is carried over from the original quote so
    // the discount stays visible after the rewrite.
    const clean = input.lines
      .map((l, i) => {
        const sku = l.sku.toUpperCase();
        const old = existing.get(sku);
        const qty = Math.max(0, Math.floor(l.qty));
        return {
          line: i + 1,
          sku,
          name: l.name ?? old?.name ?? '',
          qty,
          unitPrice: new Prisma.Decimal(l.unit_price),
          lineTotal: new Prisma.Decimal(qty * l.unit_price),
          listPrice: old?.listPrice ?? old?.unitPrice ?? null,
          gst: new Prisma.Decimal(l.gst ?? Number(old?.gst ?? 18)),
          hsn: l.hsn ?? old?.hsn ?? null,
          productId: old?.productId ?? null,
        };
      })
      .filter((l) => l.qty > 0);

    if (!clean.length) throw new ActionError('Every line has zero quantity');

    await ctx.db.requestLine.deleteMany({ where: { requestId: req.id } });
    await ctx.db.requestLine.createMany({
      data: clean.map((l) => ({ ...l, tenantId: ctx.tenantId, requestId: req.id })),
    });

    const days =
      input.validity_days ?? (Number(settings.pi_validity_days) || 15);
    const validTill = new Date(Date.now() + days * 86_400_000);
    const piNumber =
      req.piNumber ?? (await nextPiNumber(ctx, settings.pi_prefix || 'PI'));

    const placeOfSupply =
      input.place_of_supply || req.placeOfSupply || stateCodeOf(req.gstin);
    const shipAddress =
      input.ship_address !== undefined
        ? input.ship_address.slice(0, 500)
        : req.shipAddress ?? '';

    const billing = req.companyRef
      ? addressText({
          line1: req.companyRef.billLine1 ?? '', line2: req.companyRef.billLine2 ?? '',
          city: req.companyRef.billCity ?? '', state: req.companyRef.billState ?? '',
          pin: req.companyRef.billPin ?? '', country: req.companyRef.billCountry ?? '',
        })
      : '';

    const pdfLines: PiLine[] = clean.map((l) => ({
      sku: l.sku,
      name: l.name,
      qty: l.qty,
      unitPrice: Number(l.unitPrice),
      gst: Number(l.gst),
      hsn: l.hsn ?? '',
    }));

    const freight = input.freight ?? 0;
    const discount = input.discount ?? 0;

    const html = piHtml(
      {
        ref: req.ref,
        company: req.company ?? '',
        contact: req.contact ?? '',
        email: req.email ?? '',
        phone: req.phone ?? '',
        gstin: req.gstin ?? '',
        billingAddress: billing,
        shipAddress,
      },
      pdfLines,
      {
        piNumber,
        validTill: validTill.toLocaleDateString('en-IN', {
          day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
        }),
        freight,
        discount,
        notes: input.notes ?? '',
        placeOfSupply,
      },
      settings,
    );

    const pdf = await htmlToPdf(html);
    const key = buildKey(ctx.tenantId, 'pi', `${piNumber}.pdf`);
    await putObject({ key, body: pdf, contentType: 'application/pdf' });

    const total = piTotal(pdfLines, freight, discount);

    await ctx.db.request.update({
      where: { id: req.id },
      data: {
        piNumber,
        piKey: key,
        piTotal: new Prisma.Decimal(total),
        piValidTill: validTill,
        totalEst: new Prisma.Decimal(total),
        placeOfSupply: placeOfSupply || null,
        shipAddress: shipAddress || null,
      },
    });
    await audit(ctx, 'pi_built', req.ref, `${piNumber} · ${total}`);

    let status = req.status;
    if (input.send !== false) {
      ({ status } = await setStatus(ctx, req.id, 'PiSent'));
    }

    return {
      pi_number: piNumber,
      pi_url: await presignGet(key),
      pi_total: total,
      status: WIRE_STATUS[status],
    };
  },
});

defineAction('adminPiUpload', {
  tier: 'staff',
  schema: z.object({
    id: z.string().min(1),
    filename: z.string().min(1, 'data + filename required'),
    data: z.string().min(1, 'data + filename required'),
    mime: z.string().optional(),
    pi_number: z.string().optional(),
    pi_total: z.coerce.number().nonnegative().optional(),
    valid_till: z.string().optional(),
    send: z.boolean().optional(),
  }),
  async handler(input, ctx) {
    const req = await findByRef(ctx, input.id);
    const settings = await getSettings(ctx.db, ctx.tenantId);
    const bytes = decodeUpload(input.data, 'PI');

    const piNumber =
      input.pi_number ||
      req.piNumber ||
      (await nextPiNumber(ctx, settings.pi_prefix || 'PI'));

    const key = buildKey(ctx.tenantId, 'pi', input.filename);
    await putObject({
      key, body: bytes, contentType: input.mime ?? 'application/pdf',
    });

    const data: Prisma.RequestUpdateInput = { piNumber, piKey: key };
    if (input.pi_total !== undefined) {
      data.piTotal = new Prisma.Decimal(input.pi_total);
      data.totalEst = new Prisma.Decimal(input.pi_total);
    }
    if (input.valid_till) data.piValidTill = new Date(input.valid_till);

    await ctx.db.request.update({ where: { id: req.id }, data });
    await audit(ctx, 'pi_upload', req.ref, piNumber);

    if (input.send !== false) await setStatus(ctx, req.id, 'PiSent');

    return { pi_number: piNumber, pi_url: await presignGet(key) };
  },
});

defineAction('adminPoUpload', {
  tier: 'staff',
  schema: z.object({
    id: z.string().min(1),
    filename: z.string().min(1, 'data + filename required'),
    data: z.string().min(1, 'data + filename required'),
    mime: z.string().optional(),
    po_number: z.string().optional(),
  }),
  async handler(input, ctx) {
    const req = await findByRef(ctx, input.id);
    const bytes = decodeUpload(input.data, 'PO');

    const key = buildKey(ctx.tenantId, 'po', input.filename);
    await putObject({
      key, body: bytes, contentType: input.mime ?? 'application/pdf',
    });

    const poNumber = (input.po_number || req.poNumber || '').slice(0, 60);
    await ctx.db.request.update({
      where: { id: req.id },
      data: { poKey: key, poNumber: poNumber || null },
    });

    // Receiving the PO is what deducts stock, through the one state machine.
    const { status } = await setStatus(ctx, req.id, 'PoReceived');
    await audit(ctx, 'po_upload', req.ref, poNumber || input.filename);

    return { po_url: await presignGet(key), status: WIRE_STATUS[status] };
  },
});

// ------------------------------------------------------- customer order page

/**
 * The customer's own page. Authorised by the order's 28-char token alone --
 * there is no login. The token is unique across all tenants, and the lookup is
 * still tenant-scoped by RLS, so a token from one supplier cannot name another
 * supplier's order.
 */
async function byToken(ctx: ActionContext, token: string) {
  const r = await ctx.db.request.findFirst({
    where: { tenantId: ctx.tenantId, token },
    include: { lines: true, shipments: true, assignee: true },
  });
  if (!r) throw new ActionError('This order link is not valid');
  return r;
}

defineAction('orderView', {
  tier: 'public',
  schema: z.object({ t: z.string().min(1) }),
  async handler(input, ctx) {
    const r = await byToken(ctx, input.t);
    const settings = await getSettings(ctx.db, ctx.tenantId);

    // forClient: the admin-only fields are deliberately absent -- internal
    // notes, the stock state, the follow-up owner and the token itself.
    return {
      order: {
        id: r.ref,
        created: r.createdAt.toISOString(),
        status: WIRE_STATUS[r.status],
        status_dates: r.statusDates ?? {},
        company: r.company ?? '',
        contact: r.contact ?? '',
        email: r.email ?? '',
        phone: r.phone ?? '',
        gstin: r.gstin ?? '',
        notes: r.notes ?? '',
        ship_address: r.shipAddress ?? '',
        total_est: Number(r.totalEst),
        lines: r.lines
          .sort((a, b) => a.line - b.line)
          .map((l) => ({
            sku: l.sku, name: l.name, qty: l.qty,
            unit_price: Number(l.unitPrice),
            line_total: Number(l.lineTotal),
            list_price: l.listPrice ? Number(l.listPrice) : null,
            gst: l.gst === null ? '' : Number(l.gst),
            hsn: l.hsn ?? '',
          })),
        pi_number: r.piNumber ?? '',
        pi_url: r.piKey ? await presignGet(r.piKey) : '',
        pi_total: r.piTotal ? Number(r.piTotal) : 0,
        pi_valid_till: r.piValidTill ? r.piValidTill.toISOString() : '',
        po_number: r.poNumber ?? '',
        po_url: r.poKey ? await presignGet(r.poKey) : '',
        shipments: r.shipments
          .sort((a, b) => a.shipmentNo - b.shipmentNo)
          .map((s) => ({
            no: s.shipmentNo,
            date: s.shipDate ? s.shipDate.toISOString() : '',
            carrier: s.carrier ?? '', tracking: s.tracking ?? '',
            qty: s.qty, note: s.note ?? '', status: s.status,
            delivered_on: s.deliveredOn ? s.deliveredOn.toISOString() : '',
          })),
        active: !['Delivered', 'Closed', 'Rejected', 'Declined', 'Expired', 'Cancelled']
          .includes(WIRE_STATUS[r.status]),
      },
      site: { name: settings.site_name ?? 'Merchforce' },
    };
  },
});

defineAction('orderPiRespond', {
  tier: 'public',
  schema: z.object({
    t: z.string().min(1),
    accept: z.boolean(),
    note: z.string().optional(),
  }),
  async handler(input, ctx) {
    const r = await byToken(ctx, input.t);
    if (r.status !== 'PiSent') {
      throw new ActionError(
        `This proforma is not awaiting a decision (status: ${WIRE_STATUS[r.status]})`,
      );
    }

    const note = (input.note ?? '').slice(0, 300);
    // The actor is the customer, recorded as such: accepting a PI reserves
    // stock, and the audit trail must not attribute that to a staff member.
    const clientCtx = { ...ctx, actor: `client:${r.email ?? ''}` };
    const { status } = await setStatus(
      clientCtx,
      r.id,
      input.accept ? 'PiAccepted' : 'Declined',
      note,
    );

    if (note) {
      const stamp = new Date().toISOString().slice(0, 10);
      await ctx.db.request.update({
        where: { id: r.id },
        data: {
          adminNotes: `${r.adminNotes ?? ''}\n[client ${stamp}] ${note}`.trim(),
        },
      });
    }

    return { status: WIRE_STATUS[status] };
  },
});

defineAction('orderPoUpload', {
  tier: 'public',
  schema: z.object({
    t: z.string().min(1),
    filename: z.string().min(1, 'Attach the purchase order file'),
    data: z.string().min(1, 'Attach the purchase order file'),
    mime: z.string().optional(),
    po_number: z.string().optional(),
  }),
  async handler(input, ctx) {
    const r = await byToken(ctx, input.t);
    if (r.status !== 'PiAccepted' && r.status !== 'PoReceived') {
      throw new ActionError(
        'Accept the proforma invoice before sending a purchase order',
      );
    }

    const bytes = decodeUpload(input.data, 'Purchase order');
    const key = buildKey(ctx.tenantId, 'po', input.filename);
    await putObject({
      key, body: bytes, contentType: input.mime ?? 'application/pdf',
    });

    const poNumber = (input.po_number || r.poNumber || '').slice(0, 60);
    await ctx.db.request.update({
      where: { id: r.id },
      data: { poKey: key, poNumber: poNumber || null },
    });

    const clientCtx = { ...ctx, actor: `client:${r.email ?? ''}` };
    const { status } = await setStatus(clientCtx, r.id, 'PoReceived');
    await audit(clientCtx, 'po_upload', r.ref, poNumber || input.filename);

    return { status: WIRE_STATUS[status], po_url: await presignGet(key) };
  },
});
