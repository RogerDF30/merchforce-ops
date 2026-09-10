import { z } from 'zod';
import { Prisma } from '../generated/prisma/index.js';
import { ActionError, defineAction, type ActionContext } from '../lib/dispatch.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { presignGet } from '../lib/storage.js';
import { newOrderToken } from '../lib/auth.js';
import {
  FORWARD, TERMINAL, WIRE_STATUS, nextRef, parseStatus, setStatus,
} from '../lib/orderState.js';
import {
  notifyAssigned, notifyDecision, notifyNewRequest, notifyShipment,
} from '../lib/notify.js';

const num = (v: Prisma.Decimal | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);

const ACTIVE_END = new Set(['Delivered', 'Closed']);

async function orderPayload(
  ctx: ActionContext,
  r: Prisma.RequestGetPayload<{
    include: { lines: true; shipments: true; assignee: true };
  }>,
  forClient: boolean,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
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
    total_est: num(r.totalEst),
    lines: r.lines
      .sort((a, b) => a.line - b.line)
      .map((l) => ({
        sku: l.sku,
        name: l.name,
        qty: l.qty,
        unit_price: num(l.unitPrice),
        line_total: num(l.lineTotal),
        list_price: l.listPrice ? num(l.listPrice) : null,
        gst: l.gst === null ? '' : num(l.gst),
        hsn: l.hsn ?? '',
      })),
    pi_number: r.piNumber ?? '',
    // Documents are private objects, so the link is signed and short-lived
    // rather than the permanent Drive URL this used to be.
    pi_url: r.piKey ? await presignGet(r.piKey) : '',
    pi_total: num(r.piTotal),
    pi_valid_till: r.piValidTill ? r.piValidTill.toISOString() : '',
    po_number: r.poNumber ?? '',
    po_url: r.poKey ? await presignGet(r.poKey) : '',
    shipments: r.shipments
      .sort((a, b) => a.shipmentNo - b.shipmentNo)
      .map((s) => ({
        no: s.shipmentNo,
        date: s.shipDate ? s.shipDate.toISOString() : '',
        carrier: s.carrier ?? '',
        tracking: s.tracking ?? '',
        qty: s.qty,
        note: s.note ?? '',
        status: s.status,
        delivered_on: s.deliveredOn ? s.deliveredOn.toISOString() : '',
      })),
    active:
      !ACTIVE_END.has(WIRE_STATUS[r.status]) &&
      !TERMINAL.includes(r.status),
  };

  if (!forClient) {
    out.admin_notes = r.adminNotes ?? '';
    out.stock_state = r.stockState === 'none' ? '' : r.stockState;
    out.token = r.token;
    out.place_of_supply = r.placeOfSupply ?? '';
    out.company_id = r.companyId ?? '';
    out.raised_by = r.raisedBy ?? '';
    out.assigned_to = (r.assignee?.email ?? '').toLowerCase();
    out.assigned_name = r.assignee?.name ?? '';
  }
  return out;
}

async function findByRef(ctx: ActionContext, ref: string) {
  const r = await ctx.db.request.findUnique({
    where: { tenantId_ref: { tenantId: ctx.tenantId, ref } },
    include: { lines: true, shipments: true, assignee: true },
  });
  if (!r) throw new ActionError('Request not found');
  return r;
}

// ---------------------------------------------------------------------------

defineAction('adminRequests', {
  tier: 'staff',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    const rows = await ctx.db.request.findMany({
      where: { tenantId: ctx.tenantId },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
    });
    return {
      requests: rows.map((r) => ({
        id: r.ref,
        created: r.createdAt.toISOString(),
        status: WIRE_STATUS[r.status],
        company: r.company ?? '',
        contact: r.contact ?? '',
        email: r.email ?? '',
        phone: r.phone ?? '',
        gstin: r.gstin ?? '',
        notes: r.notes ?? '',
        admin_notes: r.adminNotes ?? '',
        total_est: num(r.totalEst),
        status_dates: r.statusDates ?? {},
        lines: r.lines
          .sort((a, b) => a.line - b.line)
          .map((l) => ({
            sku: l.sku,
            name: l.name,
            qty: l.qty,
            unit_price: num(l.unitPrice),
            line_total: num(l.lineTotal),
          })),
      })),
    };
  },
});

defineAction('adminOrders', {
  tier: 'staff',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    const rows = await ctx.db.request.findMany({
      where: { tenantId: ctx.tenantId },
      include: { lines: true, shipments: true, assignee: true },
      orderBy: { createdAt: 'desc' },
    });
    const settings = await getSettings(ctx.db, ctx.tenantId);
    return {
      orders: await Promise.all(rows.map((r) => orderPayload(ctx, r, false))),
      statuses: FORWARD.map((s) => WIRE_STATUS[s]),
      terminal: TERMINAL.map((s) => WIRE_STATUS[s]),
      site_url: settings.site_url ?? '',
    };
  },
});

defineAction('adminRequestUpdate', {
  tier: 'staff',
  schema: z.object({
    id: z.string().min(1),
    status: z.string().optional(),
    admin_notes: z.string().optional(),
  }),
  async handler(input, ctx) {
    const req = await findByRef(ctx, input.id);

    if (input.admin_notes !== undefined) {
      await ctx.db.request.update({
        where: { id: req.id },
        data: { adminNotes: input.admin_notes.slice(0, 2000) },
      });
    }

    let status = req.status;
    if (input.status) {
      const want = parseStatus(input.status);
      if (want !== req.status) {
        // The console calls this its "status override", and in the Apps Script
        // version that override wrote the status without running the stock
        // machine -- so an order could reach PO Received with nothing deducted.
        // It goes through the same setStatus as every other path now.
        ({ status } = await setStatus(ctx, req.id, want, 'status override'));
      }
    }

    return { id: req.ref, status: WIRE_STATUS[status] };
  },
});

defineAction('adminRequestDecide', {
  tier: 'staff',
  schema: z.object({
    id: z.string().min(1),
    accept: z.boolean(),
    note: z.string().optional(),
  }),
  async handler(input, ctx) {
    const req = await findByRef(ctx, input.id);
    const { status } = await setStatus(
      ctx,
      req.id,
      input.accept ? 'Accepted' : 'Rejected',
      input.note,
    );
    // The customer's order-page link is minted on acceptance if it has not been.
    if (input.accept && !req.token) {
      await ctx.db.request.update({
        where: { id: req.id },
        data: { token: newOrderToken() },
      });
    }

    const fresh = await findByRef(ctx, input.id);
    await notifyDecision(ctx, fresh, input.accept, input.note);

    return { status: WIRE_STATUS[status] };
  },
});

defineAction('adminRequestAssign', {
  tier: 'staff',
  schema: z.object({
    id: z.string().min(1),
    assigned_to: z.string().optional(),
  }),
  async handler(input, ctx) {
    const req = await findByRef(ctx, input.id);
    const email = (input.assigned_to ?? '').toLowerCase().trim();

    let assignedId: string | null = null;
    let name = '';
    if (email) {
      const u = await ctx.db.user.findUnique({
        where: { tenantId_email: { tenantId: ctx.tenantId, email } },
      });
      if (!u || !u.active) {
        throw new ActionError('No active staff account with that email');
      }
      assignedId = u.id;
      name = u.name || u.email;
    }

    const was = req.assignee?.email ?? '';
    await ctx.db.request.update({
      where: { id: req.id },
      data: { assignedId },
    });
    await audit(
      ctx,
      'request_assign',
      req.ref,
      `${was || 'nobody'} → ${email || 'nobody'}`,
    );

    if (email && email !== was.toLowerCase()) {
      await notifyAssigned(ctx, req, WIRE_STATUS[req.status], email);
    }

    return { id: req.ref, assigned_to: email, assigned_name: name };
  },
});

const lineSchema = z.object({
  sku: z.string().min(1),
  qty: z.coerce.number().int().positive(),
  unit_price: z.coerce.number().nonnegative().optional(),
});

defineAction('adminRequestCreate', {
  tier: 'staff',
  schema: z.object({
    company_id: z.string().optional(),
    company: z.string().optional(),
    contact: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    gstin: z.string().optional(),
    notes: z.string().optional(),
    lines: z.array(lineSchema).min(1, 'An enquiry needs at least one line'),
  }),
  async handler(input, ctx) {
    let company = input.company ?? '';
    let gstin = input.gstin ?? '';
    let placeOfSupply = '';

    if (input.company_id) {
      const co = await ctx.db.company.findFirst({
        where: { id: input.company_id, tenantId: ctx.tenantId },
      });
      if (!co) throw new ActionError('Account not found');
      company = co.name;
      gstin = gstin || co.gstin || '';
      placeOfSupply = co.stateCode ?? '';
    }
    if (!company) throw new ActionError('An enquiry needs a company');

    // Prices are resolved server side from the catalogue, never taken from the
    // client: a quantity break the browser computed is not a price we owe.
    const skus = input.lines.map((l) => l.sku.trim().toUpperCase());
    const products = await ctx.db.product.findMany({
      where: { tenantId: ctx.tenantId, sku: { in: skus } },
      include: { priceTiers: { orderBy: { minQty: 'asc' } } },
    });
    const bySku = new Map(products.map((p) => [p.sku, p]));

    const lines = input.lines.map((l, i) => {
      const sku = l.sku.trim().toUpperCase();
      const p = bySku.get(sku);
      if (!p) throw new ActionError(`No such product: ${sku}`);
      if (l.qty < p.moq) {
        throw new ActionError(`${sku}: minimum order quantity is ${p.moq}`);
      }
      // Highest tier whose threshold the quantity reaches.
      let unit = 0;
      for (const t of p.priceTiers) {
        if (l.qty >= t.minQty) unit = Number(t.unitPrice);
      }
      const listPrice = unit;
      // A staff member may discount, but the list price is kept alongside so
      // the discount is visible rather than lost.
      if (l.unit_price !== undefined) unit = l.unit_price;
      return {
        line: i + 1,
        productId: p.id,
        sku,
        name: p.name,
        qty: l.qty,
        unitPrice: new Prisma.Decimal(unit),
        listPrice: new Prisma.Decimal(listPrice),
        lineTotal: new Prisma.Decimal(unit * l.qty),
        gst: p.gstRate,
        hsn: p.hsn,
      };
    });

    const total = lines.reduce((a, l) => a + Number(l.lineTotal), 0);
    const ref = await nextRef(ctx);

    const created = await ctx.db.request.create({
      data: {
        tenantId: ctx.tenantId,
        ref,
        status: 'New',
        companyId: input.company_id ?? null,
        company,
        contact: input.contact ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        gstin: gstin || null,
        placeOfSupply: placeOfSupply || null,
        notes: input.notes ?? null,
        totalEst: new Prisma.Decimal(total),
        statusDates: { New: new Date().toISOString() },
        token: newOrderToken(),
        raisedBy: ctx.actor,
        lines: { create: lines.map((l) => ({ ...l, tenantId: ctx.tenantId })) },
      },
    });

    await audit(ctx, 'request_create', ref, company);

    const withLines = await findByRef(ctx, created.ref);
    await notifyNewRequest(ctx, withLines, withLines.lines, total);

    return { id: created.ref, total_est: total };
  },
});

defineAction('adminShipmentSave', {
  tier: 'staff',
  schema: z.object({
    id: z.string().min(1),
    shipment: z.object({
      no: z.coerce.number().int().positive().optional(),
      date: z.string().optional(),
      carrier: z.string().optional(),
      tracking: z.string().optional(),
      qty: z.coerce.number().int().nonnegative().optional(),
      note: z.string().optional(),
      status: z.enum(['pending', 'dispatched', 'delivered', 'cancelled']).optional(),
      delivered_on: z.string().optional(),
    }),
  }),
  async handler(input, ctx) {
    const req = await findByRef(ctx, input.id);
    const s = input.shipment;

    const no =
      s.no ??
      (await ctx.db.shipment.count({ where: { requestId: req.id } })) + 1;

    const data = {
      shipDate: s.date ? new Date(s.date) : null,
      carrier: s.carrier ?? null,
      tracking: s.tracking ?? null,
      qty: s.qty ?? 0,
      note: s.note ?? null,
      status: s.status ?? 'pending',
      deliveredOn: s.delivered_on ? new Date(s.delivered_on) : null,
    };

    await ctx.db.shipment.upsert({
      where: { requestId_shipmentNo: { requestId: req.id, shipmentNo: no } },
      create: { ...data, tenantId: ctx.tenantId, requestId: req.id, shipmentNo: no },
      update: data,
    });

    await audit(ctx, 'shipment_save', req.ref, `#${no}`);

    // Only a real movement is worth an email: saving a draft row that is still
    // pending would tell the customer their goods had shipped.
    if (data.status === 'dispatched' || data.status === 'delivered') {
      await notifyShipment(ctx, req, { ...data, shipmentNo: no });
    }

    return { id: req.ref, no };
  },
});

defineAction('adminShipmentDelete', {
  tier: 'staff',
  schema: z.object({
    id: z.string().min(1),
    no: z.coerce.number().int().positive(),
  }),
  async handler(input, ctx) {
    const req = await findByRef(ctx, input.id);
    const existing = await ctx.db.shipment.findUnique({
      where: { requestId_shipmentNo: { requestId: req.id, shipmentNo: input.no } },
    });
    if (!existing) throw new ActionError('Shipment not found');
    await ctx.db.shipment.delete({ where: { id: existing.id } });
    await audit(ctx, 'shipment_delete', req.ref, `#${input.no}`);
    return { id: req.ref, no: input.no };
  },
});
