/**
 * Migrate one Apps Script install into a tenant.
 *
 *   pnpm --filter @merchforce/api exec tsx scripts/migrate.ts \
 *     --from ./export --slug acme --name "Acme Merch" [--dry-run] [--skip-files]
 *
 * `--from` is a directory of CSVs exported from the backend Sheet, one per tab,
 * named after the tab: Products.csv, Requests.csv and so on. That route is used
 * rather than the live API because the Users tab carries pass_hash and salt,
 * and pulling those through the API is impossible -- it never returns them. It
 * is the difference between a supplier's whole team keeping their passwords and
 * everyone resetting on day one.
 *
 * Files referenced by Drive URL are fetched and re-uploaded to the bucket.
 * Anything unreachable is reported and the row is migrated without it: a
 * missing PI copy should not block an order's history from coming across.
 *
 * Safe to inspect first -- --dry-run reads and validates everything, reports
 * the counts and every problem it found, and writes nothing.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient, Prisma } from '../src/generated/prisma/index.js';
import { buildKey, putObject } from '../src/lib/storage.js';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')
    ? String(process.argv[i + 1])
    : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

type Row = Record<string, string>;

const problems: string[] = [];
const note = (s: string): void => {
  problems.push(s);
};

function readTab(dir: string, tab: string): Row[] {
  const file = join(dir, `${tab}.csv`);
  if (!existsSync(file)) {
    note(`${tab}.csv is missing — skipped`);
    return [];
  }
  const text = readFileSync(file, 'utf8');
  try {
    // relax_column_count, because a real Sheet export is ragged: trailing empty
    // columns get dropped from some rows and not others. Refusing the file over
    // that would block the whole migration on a formatting artefact.
    return parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
    }) as Row[];
  } catch (err) {
    note(`${tab}.csv could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const int = (v: unknown): number => Math.round(num(v));
const bool = (v: unknown): boolean => /^(true|yes|1)$/i.test(String(v ?? '').trim());
const str = (v: unknown): string => String(v ?? '').trim();
const orNull = (v: unknown): string | null => str(v) || null;

function date(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Statuses on the sheet carry spaces; the enum does not. */
const STATUS: Record<string, string> = {
  New: 'New', Accepted: 'Accepted', 'PI Sent': 'PiSent', 'PI Accepted': 'PiAccepted',
  'PO Received': 'PoReceived', 'In Production': 'InProduction',
  Dispatched: 'Dispatched', Delivered: 'Delivered', Closed: 'Closed',
  Rejected: 'Rejected', Declined: 'Declined', Expired: 'Expired', Cancelled: 'Cancelled',
  // Pre-fork storefront statuses, mapped to their nearest supplier-flow stage.
  Confirmed: 'PoReceived', Quoted: 'PiSent',
};

const SUPPLY_STATUS: Record<string, string> = {
  Planned: 'planned', Open: 'ordered', Done: 'received', Cancelled: 'cancelled',
};

async function fetchToBucket(
  url: string, tenantId: string,
  kind: 'images' | 'accounts' | 'pi' | 'po' | 'decks',
  name: string,
): Promise<string | null> {
  if (!url || !/^https?:\/\//.test(url)) return null;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      note(`could not fetch ${kind} file (HTTP ${res.status}): ${url.slice(0, 90)}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) {
      note(`empty ${kind} file: ${url.slice(0, 90)}`);
      return null;
    }
    const key = buildKey(tenantId, kind, name || 'file');
    await putObject({
      key, body: buf,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    });
    return key;
  } catch (err) {
    note(`could not fetch ${kind} file: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const dir = arg('from');
  const slug = arg('slug');
  const name = arg('name') ?? slug;
  const dryRun = flag('dry-run');
  const skipFiles = flag('skip-files');

  if (!dir || !slug) {
    console.error('Usage: migrate.ts --from <dir> --slug <slug> [--name "..."] [--dry-run] [--skip-files]');
    process.exit(1);
  }
  if (!existsSync(dir)) {
    console.error(`No such directory: ${dir}`);
    process.exit(1);
  }

  console.log(`Reading ${dir}`);
  console.log(`  found: ${readdirSync(dir).filter((f) => f.endsWith('.csv')).join(', ') || 'no CSVs'}\n`);

  const tabs = {
    settings: readTab(dir, 'Settings'),
    users: readTab(dir, 'Users'),
    brands: readTab(dir, 'Brands'),
    products: readTab(dir, 'Products'),
    tiers: readTab(dir, 'PriceTiers'),
    companies: readTab(dir, 'Companies'),
    contacts: readTab(dir, 'Contacts'),
    notes: readTab(dir, 'AccountNotes'),
    files: readTab(dir, 'AccountFiles'),
    requests: readTab(dir, 'Requests'),
    lines: readTab(dir, 'RequestLines'),
    shipments: readTab(dir, 'Shipments'),
    supply: readTab(dir, 'Supply'),
    decks: readTab(dir, 'Decks'),
    stockLog: readTab(dir, 'StockLog'),
  };

  for (const [k, v] of Object.entries(tabs)) {
    console.log(`  ${k.padEnd(10)} ${String(v.length).padStart(6)} rows`);
  }

  const existing = await prisma.tenant.findUnique({ where: { slug } });
  if (existing && !dryRun) {
    console.error(`\nTenant "${slug}" already exists (${existing.id}). Refusing to migrate into it.`);
    process.exit(1);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing was written.');
    report();
    return;
  }

  // ---- tenant
  const apiToken = `mf_${randomBytes(21).toString('base64url')}`;
  const masterKey = `mfm_${randomBytes(18).toString('base64url')}`;
  const tenant = await prisma.tenant.create({
    data: {
      slug, name: name ?? slug,
      apiTokenHash: sha256(apiToken),
      masterKeyHash: await bcrypt.hash(masterKey, 12),
    },
  });
  const T = tenant.id;
  console.log(`\nTenant ${slug} → ${T}`);

  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${T}'`);

      // ---- settings
      for (const r of tabs.settings) {
        const key = str(r.key);
        if (!key) continue;
        await tx.setting.create({ data: { tenantId: T, key, value: str(r.value) } });
      }

      // ---- users, keeping their existing passwords
      const userByEmail = new Map<string, string>();
      for (const r of tabs.users) {
        const email = str(r.email).toLowerCase();
        if (!email) continue;
        const hash = str(r.pass_hash);
        const u = await tx.user.create({
          data: {
            tenantId: T, email, name: str(r.name) || email,
            passHash: hash || (await bcrypt.hash(randomBytes(18).toString('base64url'), 12)),
            legacySalt: orNull(r.salt),
            passwordLegacy: !!hash,
            role: str(r.role) === 'admin' ? 'admin' : 'staff',
            active: r.active === undefined ? true : bool(r.active),
            lastLogin: date(r.last_login),
          },
        });
        userByEmail.set(email, u.id);
        if (!hash) note(`user ${email} had no password hash — a random one was set, they must reset`);
      }

      // ---- brands
      const brandByCode = new Map<string, string>();
      for (const r of tabs.brands) {
        const code = str(r.brand_id);
        if (!code) continue;
        const b = await tx.brand.create({
          data: {
            tenantId: T, code, name: str(r.name) || code,
            logoUrl: orNull(r.logo_url), description: orNull(r.description),
            active: r.active === undefined ? true : bool(r.active),
            sort: int(r.sort),
          },
        });
        brandByCode.set(code, b.id);
      }

      // ---- products
      const productBySku = new Map<string, string>();
      for (const r of tabs.products) {
        const sku = str(r.sku).toUpperCase();
        if (!sku) continue;
        if (productBySku.has(sku)) {
          // First occurrence wins. Overwriting with the later row looks
          // harmless until the duplicate is a half-filled copy: the second
          // KM-MUG row in a real export had no lead time, and letting it
          // through silently blanked "3-4 weeks" on the product that did.
          note(`duplicate SKU in Products: ${sku} — first row kept, later one ignored`);
          continue;
        }
        const images = str(r.image_urls).split('|').filter(Boolean);
        const keys: string[] = [];
        if (!skipFiles) {
          for (const url of images) {
            const key = await fetchToBucket(url, T, 'images', `${sku}.jpg`);
            if (key) keys.push(key);
          }
        }
        const data = {
          tenantId: T, sku, name: str(r.name) || sku,
          brandId: brandByCode.get(str(r.brand_id)) ?? null,
          category: orNull(r.category), subcategory: orNull(r.subcategory),
          description: orNull(r.description),
          specs: str(r.specs).split('|').map((s) => s.trim()).filter(Boolean),
          imageKeys: keys,
          moq: int(r.moq) || 1,
          gstRate: new Prisma.Decimal(num(r.gst_rate) || 18),
          // Text, deliberately: Sheets ate the leading zero on codes like 0902.
          hsn: orNull(r.hsn),
          mrp: num(r.mrp) ? new Prisma.Decimal(num(r.mrp)) : null,
          leadTime: orNull(r.lead_time),
          onHand: int(r.on_hand), reserved: int(r.reserved),
          safetyStock: int(r.safety_stock), reorderPoint: int(r.reorder_point),
          visible: r.visible === undefined ? true : bool(r.visible),
          showPrice: r.show_price === undefined ? true : bool(r.show_price),
          supplyMode: str(r.supply_mode) === 'make' ? ('make' as const)
            : str(r.supply_mode) === 'buy' ? ('buy' as const) : null,
          vendor: orNull(r.vendor),
          vendorMoq: int(r.vendor_moq) || null,
          batchQty: int(r.batch_qty) || null,
        };
        const p = await tx.product.upsert({
          where: { tenantId_sku: { tenantId: T, sku } },
          create: data, update: data,
        });
        productBySku.set(sku, p.id);
      }

      // ---- price tiers
      const seenTier = new Set<string>();
      for (const r of tabs.tiers) {
        const sku = str(r.sku).toUpperCase();
        const pid = productBySku.get(sku);
        if (!pid) {
          if (sku) note(`price tier for unknown SKU ${sku} — dropped`);
          continue;
        }
        const minQty = int(r.min_qty);
        const dedupe = `${pid}|${minQty}`;
        if (seenTier.has(dedupe)) {
          note(`duplicate tier ${sku} @${minQty} — one kept`);
          continue;
        }
        seenTier.add(dedupe);
        await tx.priceTier.create({
          data: {
            tenantId: T, productId: pid, minQty,
            unitPrice: new Prisma.Decimal(num(r.unit_price)),
            gst: str(r.gst) ? new Prisma.Decimal(num(r.gst)) : null,
          },
        });
      }

      // ---- companies and contacts
      const companyById = new Map<string, string>();
      for (const r of tabs.companies) {
        const oldId = str(r.company_id);
        if (!oldId) continue;
        const ownerEmail = str(r.owner_email).toLowerCase();
        const c = await tx.company.create({
          data: {
            tenantId: T, name: str(r.name) || oldId,
            gstin: orNull(r.gstin), phone: orNull(r.phone), email: orNull(r.email),
            billLine1: orNull(r.bill_line1), billLine2: orNull(r.bill_line2),
            billCity: orNull(r.bill_city), billState: orNull(r.bill_state),
            billPin: orNull(r.bill_pin), billCountry: orNull(r.bill_country) ?? 'India',
            shipSame: r.ship_same === undefined || r.ship_same === '' ? true : bool(r.ship_same),
            shipLine1: orNull(r.ship_line1), shipLine2: orNull(r.ship_line2),
            shipCity: orNull(r.ship_city), shipState: orNull(r.ship_state),
            shipPin: orNull(r.ship_pin), shipCountry: orNull(r.ship_country) ?? 'India',
            stateCode: orNull(r.state_code),
            ownerId: userByEmail.get(ownerEmail) ?? null,
            notes: orNull(r.notes),
            active: r.active === undefined ? true : bool(r.active),
          },
        });
        companyById.set(oldId, c.id);
        if (ownerEmail && !userByEmail.has(ownerEmail)) {
          note(`account "${c.name}" owned by ${ownerEmail}, who is not in Users — left unassigned`);
        }
      }

      for (const r of tabs.contacts) {
        const cid = companyById.get(str(r.company_id));
        if (!cid) {
          note(`contact ${str(r.name) || str(r.email)} on unknown account — dropped`);
          continue;
        }
        const consent = bool(r.consent);
        await tx.contact.create({
          data: {
            tenantId: T, companyId: cid, name: str(r.name),
            email: orNull(r.email), phone: orNull(r.phone), role: orNull(r.role),
            consent,
            consentTs: consent ? date(r.consent_ts) : null,
            consentSource: consent ? orNull(r.consent_source) : null,
            unsubscribed: bool(r.unsubscribed),
          },
        });
      }

      for (const r of tabs.notes) {
        const cid = companyById.get(str(r.company_id));
        if (!cid) continue;
        await tx.accountNote.create({
          data: {
            tenantId: T, companyId: cid,
            author: str(r.author) || 'migrated',
            text: str(r.text),
            createdAt: date(r.ts) ?? new Date(),
          },
        });
      }

      for (const r of tabs.files) {
        const cid = companyById.get(str(r.company_id));
        if (!cid) continue;
        const key = skipFiles ? null : await fetchToBucket(str(r.url), T, 'accounts', str(r.name));
        if (!key) {
          note(`account file "${str(r.name)}" could not be copied — row skipped`);
          continue;
        }
        await tx.accountFile.create({
          data: {
            tenantId: T, companyId: cid, name: str(r.name) || 'file', key,
            mime: orNull(r.mime), size: int(r.size) || null,
            uploadedBy: orNull(r.uploaded_by),
            createdAt: date(r.ts) ?? new Date(),
          },
        });
      }

      // ---- requests, lines, shipments
      const requestByRef = new Map<string, string>();
      for (const r of tabs.requests) {
        const ref = str(r.request_id);
        if (!ref) continue;
        const wire = str(r.status);
        const status = STATUS[wire];
        if (!status) {
          note(`request ${ref} has unknown status "${wire}" — imported as New`);
        }
        let statusDates: Prisma.InputJsonValue = {};
        try {
          statusDates = JSON.parse(str(r.status_dates) || '{}') as Prisma.InputJsonValue;
        } catch {
          note(`request ${ref} had unreadable status_dates — reset to empty`);
        }
        const piKey = skipFiles ? null : await fetchToBucket(str(r.pi_url), T, 'pi', `${str(r.pi_number) || ref}.pdf`);
        const poKey = skipFiles ? null : await fetchToBucket(str(r.po_url), T, 'po', `${str(r.po_number) || ref}.pdf`);

        const req = await tx.request.create({
          data: {
            tenantId: T, ref,
            status: (status ?? 'New') as never,
            stockState: (str(r.stock_state) || 'none') as never,
            companyId: companyById.get(str(r.company_id)) ?? null,
            company: orNull(r.company), contact: orNull(r.contact),
            email: orNull(r.email), phone: orNull(r.phone), gstin: orNull(r.gstin),
            notes: orNull(r.notes), adminNotes: orNull(r.admin_notes),
            totalEst: new Prisma.Decimal(num(r.total_est)),
            statusDates,
            // A token must exist and be unique; a blank one gets a fresh link.
            token: str(r.token) || randomBytes(21).toString('base64url').slice(0, 28),
            piNumber: orNull(r.pi_number), piKey,
            piTotal: num(r.pi_total) ? new Prisma.Decimal(num(r.pi_total)) : null,
            piValidTill: date(r.pi_valid_till),
            poNumber: orNull(r.po_number), poKey,
            shipAddress: orNull(r.ship_address), placeOfSupply: orNull(r.place_of_supply),
            raisedBy: orNull(r.raised_by),
            assignedId: userByEmail.get(str(r.assigned_to).toLowerCase()) ?? null,
            createdAt: date(r.created) ?? new Date(),
          },
        });
        requestByRef.set(ref, req.id);
      }

      const seenLine = new Set<string>();
      for (const r of tabs.lines) {
        const rid = requestByRef.get(str(r.request_id));
        if (!rid) {
          note(`line for unknown request ${str(r.request_id)} — dropped`);
          continue;
        }
        let line = int(r.line) || 1;
        while (seenLine.has(`${rid}|${line}`)) line++;
        seenLine.add(`${rid}|${line}`);
        const sku = str(r.sku).toUpperCase();
        await tx.requestLine.create({
          data: {
            tenantId: T, requestId: rid, line, sku, name: str(r.name) || sku,
            productId: productBySku.get(sku) ?? null,
            qty: int(r.qty),
            unitPrice: new Prisma.Decimal(num(r.unit_price)),
            listPrice: str(r.list_price) ? new Prisma.Decimal(num(r.list_price)) : null,
            lineTotal: new Prisma.Decimal(num(r.line_total)),
            gst: str(r.gst) ? new Prisma.Decimal(num(r.gst)) : null,
            hsn: orNull(r.hsn),
          },
        });
      }

      const seenShip = new Set<string>();
      for (const r of tabs.shipments) {
        const rid = requestByRef.get(str(r.request_id));
        if (!rid) continue;
        let no = int(r.shipment_no) || 1;
        while (seenShip.has(`${rid}|${no}`)) no++;
        seenShip.add(`${rid}|${no}`);
        const st = str(r.status).toLowerCase();
        await tx.shipment.create({
          data: {
            tenantId: T, requestId: rid, shipmentNo: no,
            shipDate: date(r.ship_date), carrier: orNull(r.carrier),
            tracking: orNull(r.tracking), qty: int(r.qty), note: orNull(r.note),
            status: (['pending', 'dispatched', 'delivered', 'cancelled'].includes(st)
              ? st : 'pending') as never,
            deliveredOn: date(r.delivered_on),
          },
        });
      }

      // ---- supply orders
      for (const r of tabs.supply) {
        const sku = str(r.sku).toUpperCase();
        const pid = productBySku.get(sku);
        if (!pid) {
          if (sku) note(`supply order for unknown SKU ${sku} — dropped`);
          continue;
        }
        await tx.supplyOrder.create({
          data: {
            tenantId: T, ref: str(r.so_id) || `SO-${randomBytes(4).toString('hex')}`,
            kind: (str(r.kind) === 'make' ? 'make' : 'buy') as never,
            productId: pid, sku, name: str(r.name) || sku,
            qty: int(r.qty), vendor: orNull(r.vendor),
            status: (SUPPLY_STATUS[str(r.status)] ?? 'planned') as never,
            expected: date(r.expected), externalRef: orNull(r.ref), note: orNull(r.note),
            receivedQty: int(r.received_qty), receivedAt: date(r.received),
            createdBy: orNull(r.created_by),
            createdAt: date(r.created) ?? new Date(),
          },
        });
      }

      // ---- decks
      for (const r of tabs.decks) {
        const pdfKey = skipFiles ? null : await fetchToBucket(str(r.pdf_url), T, 'decks', `${str(r.name)}.pdf`);
        const pptxKey = skipFiles ? null : await fetchToBucket(str(r.pptx_url), T, 'decks', `${str(r.name)}.pptx`);
        await tx.deck.create({
          data: {
            tenantId: T, name: str(r.name) || 'Deck',
            skus: str(r.skus).split('|').filter(Boolean),
            companyId: companyById.get(str(r.company_id)) ?? null,
            company: orNull(r.company),
            pdfKey, pptxKey,
            createdBy: orNull(r.created_by),
            sentTo: orNull(r.sent_to), lastSent: date(r.last_sent),
            createdAt: date(r.created) ?? new Date(),
          },
        });
      }

      // ---- stock ledger, so history survives the move
      for (const r of tabs.stockLog) {
        const sku = str(r.sku).toUpperCase();
        const pid = productBySku.get(sku);
        if (!pid) continue;
        await tx.stockLog.create({
          data: {
            tenantId: T, productId: pid, sku,
            delta: int(r.delta), reason: str(r.reason) || 'migrated',
            actor: orNull(r.actor),
            createdAt: date(r.ts) ?? new Date(),
          },
        });
      }
    },
    { timeout: 15 * 60 * 1000, maxWait: 60_000 },
  );

  const counts = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${T}'`);
    return {
      users: await tx.user.count(), brands: await tx.brand.count(),
      products: await tx.product.count(), tiers: await tx.priceTier.count(),
      companies: await tx.company.count(), contacts: await tx.contact.count(),
      requests: await tx.request.count(), lines: await tx.requestLine.count(),
      shipments: await tx.shipment.count(), supply: await tx.supplyOrder.count(),
      decks: await tx.deck.count(), stockLog: await tx.stockLog.count(),
      settings: await tx.setting.count(),
    };
  });

  console.log('\nMigrated:');
  for (const [k, v] of Object.entries(counts)) {
    const from = ({
      users: tabs.users.length, brands: tabs.brands.length, products: tabs.products.length,
      tiers: tabs.tiers.length, companies: tabs.companies.length, contacts: tabs.contacts.length,
      requests: tabs.requests.length, lines: tabs.lines.length, shipments: tabs.shipments.length,
      supply: tabs.supply.length, decks: tabs.decks.length, stockLog: tabs.stockLog.length,
      settings: tabs.settings.length,
    } as Record<string, number>)[k];
    const gap = from !== undefined && from !== v ? `  (${from} in the export)` : '';
    console.log(`  ${k.padEnd(10)} ${String(v).padStart(6)}${gap}`);
  }

  console.log(`
Credentials — store these now, only hashes are kept
  API token   ${apiToken}
  master key  ${masterKey}

Staff keep their existing passwords. Set LEGACY_PEPPER to the PEPPER from the
old install's Script Properties, or nobody can sign in.`);

  report();
}

function report(): void {
  if (!problems.length) {
    console.log('\nNo problems found.');
    return;
  }
  console.log(`\n${problems.length} thing${problems.length === 1 ? '' : 's'} to look at:`);
  for (const p of problems.slice(0, 60)) console.log(`  · ${p}`);
  if (problems.length > 60) console.log(`  … and ${problems.length - 60} more`);
}

main()
  .catch((e) => {
    console.error('\nMigration failed:', e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
