import { z } from 'zod';
import { ActionError, defineAction } from '../lib/dispatch.js';
import { audit } from '../lib/audit.js';
import {
  addressText,
  companyKey,
  normaliseAddress,
  stateCodeByName,
  stateCodeOf,
  type Address,
} from '../lib/gst.js';
import {
  assertKeyBelongsTo,
  buildKey,
  deleteObject,
  presignGet,
  putObject,
} from '../lib/storage.js';

const addrSchema = z
  .object({
    line1: z.string().optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    pin: z.string().optional(),
    country: z.string().optional(),
  })
  .optional();

/** Shape the console expects for each address block. */
const addrOut = (
  r: Record<string, unknown>,
  pfx: 'bill' | 'ship',
): Address => ({
  line1: String(r[`${pfx}Line1`] ?? ''),
  line2: String(r[`${pfx}Line2`] ?? ''),
  city: String(r[`${pfx}City`] ?? ''),
  state: String(r[`${pfx}State`] ?? ''),
  pin: String(r[`${pfx}Pin`] ?? ''),
  country: String(r[`${pfx}Country`] ?? ''),
});

// ---------------------------------------------------------------------------

defineAction('adminCompanies', {
  tier: 'staff',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    const [companies, contacts, requests, noteCounts, fileCounts] =
      await Promise.all([
        ctx.db.company.findMany({
          where: { tenantId: ctx.tenantId },
          include: { owner: { select: { name: true, email: true } } },
        }),
        ctx.db.contact.findMany({
          where: { tenantId: ctx.tenantId },
          orderBy: { createdAt: 'asc' },
        }),
        ctx.db.request.findMany({
          where: { tenantId: ctx.tenantId },
          select: {
            companyId: true,
            company: true,
            piTotal: true,
            totalEst: true,
          },
        }),
        ctx.db.accountNote.groupBy({
          by: ['companyId'],
          where: { tenantId: ctx.tenantId },
          _count: true,
        }),
        ctx.db.accountFile.groupBy({
          by: ['companyId'],
          where: { tenantId: ctx.tenantId },
          _count: true,
        }),
      ]);

    // Order count and lifetime value per account. The PI total wins over the
    // estimate once one has been issued.
    const orders = new Map<string, number>();
    const value = new Map<string, number>();
    for (const r of requests) {
      if (!r.companyId) continue;
      orders.set(r.companyId, (orders.get(r.companyId) ?? 0) + 1);
      const amt = r.piTotal ? Number(r.piTotal) : Number(r.totalEst);
      value.set(r.companyId, (value.get(r.companyId) ?? 0) + amt);
    }

    const contactCounts = new Map<string, number>();
    for (const c of contacts) {
      contactCounts.set(c.companyId, (contactCounts.get(c.companyId) ?? 0) + 1);
    }
    const noteCount = new Map(noteCounts.map((n) => [n.companyId, n._count]));
    const fileCount = new Map(fileCounts.map((f) => [f.companyId, f._count]));

    const out = companies
      .map((r) => {
        const bill = addrOut(r as unknown as Record<string, unknown>, 'bill');
        const ship = r.shipSame
          ? bill
          : addrOut(r as unknown as Record<string, unknown>, 'ship');
        const billText = addressText(bill);
        return {
          id: r.id,
          name: r.name,
          gstin: r.gstin ?? '',
          phone: r.phone ?? '',
          email: r.email ?? '',
          // Composed here rather than stored: the PI and order page print these,
          // and a stored copy would drift from the structured parts.
          billing_address: billText,
          ship_address: r.shipSame ? billText : addressText(ship),
          state_code: r.stateCode ?? '',
          owner: r.owner?.name ?? '',
          owner_email: (r.owner?.email ?? '').toLowerCase(),
          notes: r.notes ?? '',
          bill,
          ship,
          ship_same: r.shipSame,
          active: r.active,
          created: r.createdAt.toISOString(),
          contacts: contactCounts.get(r.id) ?? 0,
          orders: orders.get(r.id) ?? 0,
          value: Math.round(value.get(r.id) ?? 0),
          notes_count: noteCount.get(r.id) ?? 0,
          files_count: fileCount.get(r.id) ?? 0,
        };
      })
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

    // Orders raised before accounts existed, so the console can offer the import.
    const unlinked = new Map<string, number>();
    for (const r of requests) {
      if (r.companyId) continue;
      const k = companyKey(r.company);
      if (!k) continue;
      unlinked.set(k, (unlinked.get(k) ?? 0) + 1);
    }

    return {
      companies: out,
      contacts: contacts.map((c) => ({
        id: c.id,
        company_id: c.companyId,
        name: c.name,
        email: c.email ?? '',
        phone: c.phone ?? '',
        role: c.role ?? '',
        consent: c.consent,
        consent_ts: c.consentTs ? c.consentTs.toISOString() : '',
        consent_source: c.consentSource ?? '',
        unsubscribed: c.unsubscribed,
        created: c.createdAt.toISOString(),
      })),
      unlinked_names: unlinked.size,
      unlinked_orders: [...unlinked.values()].reduce((a, b) => a + b, 0),
    };
  },
});

defineAction('adminCompanySave', {
  tier: 'staff',
  schema: z.object({
    company: z.object({
      id: z.string().optional(),
      name: z.string().trim().min(1, 'Company name is required'),
      gstin: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      state_code: z.string().optional(),
      owner_email: z.string().optional(),
      notes: z.string().optional(),
      active: z.boolean().optional(),
      ship_same: z.boolean().optional(),
      bill: addrSchema,
      ship: addrSchema,
    }),
  }),
  async handler(input, ctx) {
    const d = input.company;
    const bill = normaliseAddress(d.bill);
    const shipSame = d.ship_same !== false;
    const ship = shipSame ? bill : normaliseAddress(d.ship);

    // Place of supply: explicit wins, then the billing state, then the GSTIN.
    const stateCode =
      (d.state_code ?? '').trim() ||
      stateCodeByName(bill.state) ||
      stateCodeOf(d.gstin);

    let ownerId: string | null = null;
    const ownerEmail = (d.owner_email ?? '').toLowerCase().trim();
    if (ownerEmail) {
      const u = await ctx.db.user.findUnique({
        where: { tenantId_email: { tenantId: ctx.tenantId, email: ownerEmail } },
      });
      if (!u) throw new ActionError(`No staff account for ${ownerEmail}`);
      ownerId = u.id;
    }

    const data = {
      name: d.name.trim(),
      gstin: (d.gstin ?? '').trim().toUpperCase() || null,
      phone: d.phone ?? null,
      email: d.email ?? null,
      stateCode: stateCode || null,
      ownerId,
      notes: d.notes ?? null,
      active: d.active !== false,
      shipSame,
      billLine1: bill.line1, billLine2: bill.line2, billCity: bill.city,
      billState: bill.state, billPin: bill.pin, billCountry: bill.country,
      shipLine1: ship.line1, shipLine2: ship.line2, shipCity: ship.city,
      shipState: ship.state, shipPin: ship.pin, shipCountry: ship.country,
    };

    let id: string;
    if (d.id) {
      const existing = await ctx.db.company.findFirst({
        where: { id: d.id, tenantId: ctx.tenantId },
      });
      if (!existing) throw new ActionError('Company not found');
      await ctx.db.company.update({ where: { id: d.id }, data });
      id = d.id;
    } else {
      const created = await ctx.db.company.create({
        data: { ...data, tenantId: ctx.tenantId },
      });
      id = created.id;
    }

    await audit(ctx, 'company_save', id, data.name);
    return { id };
  },
});

defineAction('adminCompanyDelete', {
  tier: 'staff',
  schema: z.object({ id: z.string().min(1) }),
  async handler(input, ctx) {
    const co = await ctx.db.company.findFirst({
      where: { id: input.id, tenantId: ctx.tenantId },
    });
    if (!co) throw new ActionError('Company not found');

    const used = await ctx.db.request.count({ where: { companyId: input.id } });
    if (used > 0) {
      throw new ActionError(
        'This company has orders against it. Deactivate it instead.',
      );
    }

    // Contacts, notes and files cascade with the row (see the schema); the
    // stored objects do not, so they are removed explicitly first.
    const files = await ctx.db.accountFile.findMany({
      where: { companyId: input.id },
      select: { key: true },
    });
    for (const f of files) {
      try {
        await deleteObject(f.key);
      } catch {
        // A missing object must not block deleting the account.
      }
    }

    await ctx.db.company.delete({ where: { id: input.id } });
    await audit(ctx, 'company_delete', input.id, co.name);
    return { id: input.id };
  },
});

defineAction('adminContactSave', {
  tier: 'staff',
  schema: z.object({
    contact: z
      .object({
        id: z.string().optional(),
        company_id: z.string().min(1, 'A contact must belong to a company'),
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        role: z.string().optional(),
        consent: z.boolean().optional(),
        consent_source: z.string().optional(),
        unsubscribed: z.boolean().optional(),
      })
      .refine((c) => c.name || c.email, {
        message: 'Give the contact a name or an email',
      })
      .refine((c) => !c.email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email), {
        message: 'Invalid email',
      }),
  }),
  async handler(input, ctx) {
    const d = input.contact;
    const co = await ctx.db.company.findFirst({
      where: { id: d.company_id, tenantId: ctx.tenantId },
    });
    if (!co) throw new ActionError('Account not found');

    const existing = d.id
      ? await ctx.db.contact.findFirst({
          where: { id: d.id, tenantId: ctx.tenantId },
        })
      : null;
    if (d.id && !existing) throw new ActionError('Contact not found');

    // Consent is only meaningful with a record of when it was given and where
    // from, so the original timestamp survives an unrelated edit and both are
    // cleared together when consent is withdrawn.
    const consent = !!d.consent;
    const hadConsent = existing?.consent ?? false;

    const data = {
      companyId: d.company_id,
      name: d.name ?? '',
      email: (d.email ?? '').trim() || null,
      phone: d.phone ?? null,
      role: d.role ?? null,
      consent,
      consentTs: consent
        ? hadConsent && existing?.consentTs
          ? existing.consentTs
          : new Date()
        : null,
      consentSource: consent
        ? d.consent_source ??
          (hadConsent ? existing?.consentSource ?? null : 'recorded in console')
        : null,
      unsubscribed: !!d.unsubscribed,
    };

    const saved = existing
      ? await ctx.db.contact.update({ where: { id: existing.id }, data })
      : await ctx.db.contact.create({ data: { ...data, tenantId: ctx.tenantId } });

    await audit(ctx, 'contact_save', saved.id, saved.email ?? saved.name);
    return { id: saved.id };
  },
});

defineAction('adminContactDelete', {
  tier: 'staff',
  schema: z.object({ id: z.string().min(1) }),
  async handler(input, ctx) {
    const c = await ctx.db.contact.findFirst({
      where: { id: input.id, tenantId: ctx.tenantId },
    });
    if (!c) throw new ActionError('Contact not found');
    await ctx.db.contact.delete({ where: { id: input.id } });
    await audit(ctx, 'contact_delete', input.id);
    return { id: input.id };
  },
});

// --------------------------------------------------------------- notes/files

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Account files were Drive files with a permanent public link. They are private
 * objects now, so each one is handed out as a presigned URL that expires -- a
 * link copied out of the console stops working rather than staying live forever.
 */
async function fileOut(f: {
  id: string;
  companyId: string;
  name: string;
  key: string;
  mime: string | null;
  size: number | null;
  uploadedBy: string | null;
  createdAt: Date;
}) {
  return {
    id: f.id,
    company_id: f.companyId,
    name: f.name,
    url: await presignGet(f.key),
    drive_id: f.key,
    mime: f.mime ?? '',
    size: f.size ?? 0,
    uploaded_by: f.uploadedBy ?? '',
    ts: f.createdAt.toISOString(),
  };
}

const noteOut = (n: {
  id: string;
  companyId: string;
  createdAt: Date;
  author: string;
  text: string;
}) => ({
  id: n.id,
  company_id: n.companyId,
  ts: n.createdAt.toISOString(),
  author: n.author,
  text: n.text,
});

defineAction('adminAccountNotes', {
  tier: 'staff',
  schema: z.object({ company_id: z.string().min(1, 'company_id required') }),
  async handler(input, ctx) {
    const co = await ctx.db.company.findFirst({
      where: { id: input.company_id, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!co) throw new ActionError('Account not found');

    const [notes, files] = await Promise.all([
      ctx.db.accountNote.findMany({
        where: { tenantId: ctx.tenantId, companyId: input.company_id },
        orderBy: { createdAt: 'desc' },
      }),
      ctx.db.accountFile.findMany({
        where: { tenantId: ctx.tenantId, companyId: input.company_id },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      notes: notes.map(noteOut),
      files: await Promise.all(files.map(fileOut)),
    };
  },
});

defineAction('adminAccountNoteSave', {
  tier: 'staff',
  schema: z.object({
    id: z.string().optional(),
    company_id: z.string().optional(),
    text: z.string(),
  }),
  async handler(input, ctx) {
    const text = input.text.trim().slice(0, 4000);
    if (!text) throw new ActionError('Write something first');

    if (input.id) {
      const existing = await ctx.db.accountNote.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
      });
      if (!existing) throw new ActionError('Note not found');
      const updated = await ctx.db.accountNote.update({
        where: { id: input.id },
        data: { text },
      });
      await audit(ctx, 'account_note_edit', updated.companyId, updated.id);
      return { note: noteOut(updated) };
    }

    if (!input.company_id) throw new ActionError('company_id required');
    const co = await ctx.db.company.findFirst({
      where: { id: input.company_id, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!co) throw new ActionError('Account not found');

    const created = await ctx.db.accountNote.create({
      data: {
        tenantId: ctx.tenantId,
        companyId: input.company_id,
        author: ctx.actor,
        text,
      },
    });
    await audit(ctx, 'account_note', created.companyId, created.id);
    return { note: noteOut(created) };
  },
});

defineAction('adminAccountNoteDelete', {
  tier: 'staff',
  schema: z.object({ id: z.string().min(1) }),
  async handler(input, ctx) {
    const n = await ctx.db.accountNote.findFirst({
      where: { id: input.id, tenantId: ctx.tenantId },
    });
    if (!n) throw new ActionError('Note not found');
    await ctx.db.accountNote.delete({ where: { id: input.id } });
    await audit(ctx, 'account_note_delete', n.companyId, input.id);
    return {};
  },
});

defineAction('adminAccountFileUpload', {
  tier: 'staff',
  schema: z.object({
    company_id: z.string().min(1),
    filename: z.string().min(1, 'data + filename required'),
    mime: z.string().optional(),
    data: z.string().min(1, 'data + filename required'),
  }),
  async handler(input, ctx) {
    const co = await ctx.db.company.findFirst({
      where: { id: input.company_id, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!co) throw new ActionError('Account not found');

    const b64 = input.data.replace(/^data:[^;]+;base64,/, '');
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length === 0) throw new ActionError('File is empty or not valid base64');
    if (bytes.length > MAX_FILE_BYTES) throw new ActionError('File over 10MB');

    const name = input.filename.slice(0, 120);
    const mime = input.mime || 'application/octet-stream';
    const key = buildKey(ctx.tenantId, 'accounts', name);

    // Unlike product images this accepts any type -- these are the customer's
    // KYC documents and artwork. putObject marks anything not image/PDF as an
    // attachment, so an uploaded .html cannot execute on our origin.
    await putObject({ key, body: bytes, contentType: mime });

    const rec = await ctx.db.accountFile.create({
      data: {
        tenantId: ctx.tenantId,
        companyId: input.company_id,
        name,
        key,
        mime,
        size: bytes.length,
        uploadedBy: ctx.actor,
      },
    });

    await audit(ctx, 'account_file', rec.companyId, rec.name);
    return { file: await fileOut(rec) };
  },
});

defineAction('adminAccountFileDelete', {
  tier: 'staff',
  schema: z.object({ id: z.string().min(1) }),
  async handler(input, ctx) {
    const f = await ctx.db.accountFile.findFirst({
      where: { id: input.id, tenantId: ctx.tenantId },
    });
    if (!f) throw new ActionError('File not found');

    // Belt and braces: the row was already fetched under the tenant's RLS
    // policy, so the key must match -- if it does not, something is wrong
    // enough to stop rather than delete another tenant's object.
    assertKeyBelongsTo(ctx.tenantId, f.key);

    try {
      await deleteObject(f.key);
    } catch {
      // The row goes regardless: a stranded object is better than a row
      // pointing at something the user believes is gone.
    }
    await ctx.db.accountFile.delete({ where: { id: input.id } });
    await audit(ctx, 'account_file_delete', f.companyId, f.name);
    return {};
  },
});

/**
 * Backfill: orders raised before accounts existed carry a company NAME but no
 * company_id. Group those by a loose name key, create the missing accounts, and
 * link the orders. Idempotent -- a second run finds nothing left unlinked.
 */
defineAction('adminCompanyImport', {
  tier: 'staff',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    const requests = await ctx.db.request.findMany({
      where: { tenantId: ctx.tenantId, companyId: null },
      orderBy: { createdAt: 'desc' },
    });

    const existing = new Map<string, string>();
    for (const c of await ctx.db.company.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, name: true },
    })) {
      existing.set(companyKey(c.name), c.id);
    }

    const groups = new Map<string, typeof requests>();
    for (const r of requests) {
      const k = companyKey(r.company);
      if (!k) continue;
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }

    let madeCo = 0;
    let madeCt = 0;
    let linked = 0;

    for (const [key, group] of groups) {
      // Ordered newest-first above, so the first row carries the freshest details.
      const latest = group[0];
      if (!latest) continue;

      let companyId = existing.get(key);
      if (!companyId) {
        const created = await ctx.db.company.create({
          data: {
            tenantId: ctx.tenantId,
            name: (latest.company ?? '').trim(),
            gstin: latest.gstin ?? null,
            phone: latest.phone ?? null,
            email: latest.email ?? null,
            stateCode: latest.placeOfSupply ?? null,
            notes: 'Imported from order history',
            active: true,
          },
        });
        companyId = created.id;
        existing.set(key, companyId);
        madeCo++;
      }

      const res = await ctx.db.request.updateMany({
        where: { id: { in: group.map((r) => r.id) } },
        data: { companyId },
      });
      linked += res.count;

      const email = (latest.email ?? '').trim();
      if (email) {
        const seen = await ctx.db.contact.findFirst({
          where: { tenantId: ctx.tenantId, companyId, email },
          select: { id: true },
        });
        if (!seen) {
          await ctx.db.contact.create({
            data: {
              tenantId: ctx.tenantId,
              companyId,
              name: latest.contact ?? '',
              email,
              phone: latest.phone ?? null,
              // An order is a business relationship, not marketing consent.
              consent: false,
              unsubscribed: false,
            },
          });
          madeCt++;
        }
      }
    }

    await audit(
      ctx,
      'company_import',
      undefined,
      `${madeCo} accounts, ${madeCt} contacts, ${linked} orders linked`,
    );
    return { companies: madeCo, contacts: madeCt, linked };
  },
});
