// Google Sheet stock sync (pull mode) for the console, plus the per-minute
// tick from pg_cron: write stock/holds back into sheets, and pull sheets whose
// schedule is due. All product changes happen in mf_service_sync_apply.
import { asCaller, asService, cors, fail, reply } from '../_shared/http.ts';
import { batchUpdate, colA1, meta, readTabs, SERVICE_EMAIL, sheetId, writeCells, writeRange } from '../_shared/google.ts';

type Body = Record<string, any>;
type Map = { id: string; brand: string; sheet: string; sources: { tab: string; sku_col: string; fields: { col: string; field: string }[] }[];
             write_back?: boolean; create_new?: boolean };

const NUMERIC = new Set(['on_hand', 'price', 'mrp', 'moq', 'gst_rate']);
const HEADERS = ['Code', 'Product Name', 'HSN', 'GST %', 'MRP', 'Selling Price Excluding GST', 'Stock', 'Committed', 'Available', 'MOQ', 'Lead Time', 'Image URL'];
const key = (v: unknown) => String(v ?? '').trim().toUpperCase();

async function adminMaps(req: Request, vendor: string) {
  const r = await asCaller(req).rpc('mf_admin_sync_maps', { p: { vendor } });
  if (r.error) throw new Error(r.error.message);
  return r.data as { vendor_id: string; actor: string; maps: Map[] };
}

/** Read a map's tabs and merge rows into {sku, values} across sources, as StockSync.gs did. */
async function incomingFor(m: Map) {
  const tabs = [...new Set(m.sources.map((s) => s.tab))];
  const info = await meta(m.sheet);
  const real = tabs.map((t) => t || info.tabs[0]?.name || '');
  const data = await readTabs(m.sheet, real);
  const merged = new Map<string, { sku: string; values: Record<string, unknown> }>();
  m.sources.forEach((src) => {
    const tab = src.tab || info.tabs[0]?.name || '';
    const rows = data[tab];
    if (!rows) throw new Error(`Tab "${tab}" not found in that sheet`);
    const headers = (rows[0] ?? []).map((h) => String(h).trim());
    const iSku = headers.indexOf(String(src.sku_col).trim());
    if (iSku < 0) throw new Error(`SKU column "${src.sku_col}" not found in tab "${tab}"`);
    const cols = src.fields.map((f) => {
      const i = headers.indexOf(String(f.col).trim());
      if (i < 0) throw new Error(`Column "${f.col}" not found in tab "${tab}"`);
      return { i, field: f.field };
    });
    for (const row of rows.slice(1)) {
      const raw = String(row[iSku] ?? '').trim();
      if (!raw) continue;
      const rec = merged.get(key(raw)) ?? { sku: raw, values: {} };
      for (const c of cols) {
        const v = row[c.i];
        if (NUMERIC.has(c.field)) {
          const n = v === '' || v === undefined || v === null ? NaN : Number(v);
          let num: number | null = isNaN(n) ? null : Math.max(0, c.field === 'gst_rate' ? n : Math.floor(n * 100) / 100);
          if ((c.field === 'on_hand' || c.field === 'moq') && num !== null) num = Math.floor(num);
          rec.values[c.field] = num;
        } else {
          rec.values[c.field] = String(v ?? '').trim();
        }
      }
      merged.set(key(raw), rec);
    }
  });
  return [...merged.values()];
}

async function runMap(vendorId: string, m: Map, actor: string) {
  let incoming: unknown[] = [], error = '';
  try { incoming = await incomingFor(m); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  const r = await asService().rpc('mf_service_sync_apply', { p: { vendor_id: vendorId, map_id: m.id, incoming, actor, error } });
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

/** Write Stock / Committed / Available for queued SKUs into every write-back map's tabs. */
async function processWriteBacks(onlyVendor?: string) {
  const svc = asService();
  const batch = await svc.rpc('mf_service_writeback_batch', { p: onlyVendor ? { vendor_id: onlyVendor } : {} });
  if (batch.error) throw new Error(batch.error.message);
  const out = { written: 0, errors: [] as string[] };
  for (const v of batch.data.vendors as any[]) {
    const results: { id: string; written: number; error: string }[] = [], seen: { sku: string; value: number }[] = [];
    for (const m of v.maps as Map[]) {
      let written = 0, error = '';
      try {
        const mine = (v.products as any[]).filter((p) => !m.brand || p.brand === m.brand);
        for (const src of m.sources) {
          const stockField = src.fields.find((f) => f.field === 'on_hand');
          if (!stockField || !mine.length) continue;
          const tab = src.tab || (await meta(m.sheet)).tabs[0]?.name || '';
          const rows = (await readTabs(m.sheet, [tab]))[tab] ?? [];
          const headers = (rows[0] ?? []).map((h) => String(h).trim());
          const iSku = headers.indexOf(src.sku_col), iStock = headers.indexOf(stockField.col);
          if (iSku < 0 || iStock < 0) throw new Error(`column "${iSku < 0 ? src.sku_col : stockField.col}" not found in tab "${tab}"`);
          const iCom = headers.findIndex((h) => h.toLowerCase() === 'committed');
          const iAv = headers.findIndex((h) => h.toLowerCase() === 'available');
          const rowOf = new Map<string, number>();
          rows.slice(1).forEach((r, i) => { const k = key(r[iSku]); if (k && !rowOf.has(k)) rowOf.set(k, i + 1); });
          const cells: { tab: string; a1: string; value: unknown }[] = [];
          for (const p of mine) {
            const r = rowOf.get(key(p.sku));
            if (r === undefined) continue;
            const row = rows[r] ?? [];
            const put = (i: number, val: number) => { if (i >= 0 && (row[i] === '' || row[i] === undefined || Number(row[i]) !== val)) cells.push({ tab, a1: colA1(i) + (r + 1), value: val }); };
            put(iCom, p.reserved); put(iAv, p.atp);
            if (Number(row[iStock]) !== p.on_hand || row[iStock] === '' || row[iStock] === undefined) {
              cells.push({ tab, a1: colA1(iStock) + (r + 1), value: p.on_hand }); written++;
            }
            seen.push({ sku: p.sku, value: p.on_hand });   // the sheet now shows what we hold
          }
          await writeCells(m.sheet, cells);
        }
      } catch (e) {
        error = (m.brand || 'all') + ': ' + (e instanceof Error ? e.message : String(e));
        out.errors.push(error);
      }
      results.push({ id: m.id, written, error });
      out.written += written;
    }
    await svc.rpc('mf_service_writeback_done', { p: { vendor_id: v.vendor_id, ids: v.ids, ok: true,
                                                       error: results.map((r) => r.error).filter(Boolean).join(' | '),
                                                       maps: results, seen } });
  }
  return out;
}

/** Share links that point at a viewer page, turned into a direct download. */
function directUrl(u: string): string {
  const drive = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([A-Za-z0-9_-]{20,})/);
  if (drive) return 'https://drive.google.com/uc?export=download&id=' + drive[1];
  if (/dropbox\.com\//.test(u)) return u.replace(/([?&])dl=0/, '$1dl=1') + (/[?&]dl=/.test(u) ? '' : (u.includes('?') ? '&' : '?') + 'dl=1');
  return u;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Copy queued sheet image links into the vendor's images folder. */
async function processImages() {
  const svc = asService();
  const batch = await svc.rpc('mf_service_image_batch', { p: {} });
  if (batch.error) throw new Error(batch.error.message);
  let done = 0;
  for (const job of batch.data.jobs as { id: number; vendor_id: string; sku: string; urls: string[] }[]) {
    const images: string[] = [], errs: string[] = [];
    for (const [i, u] of job.urls.slice(0, 8).entries()) {
      try {
        const res = await fetch(directUrl(u), { redirect: 'follow' });
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (!res.ok) throw new Error('HTTP ' + res.status);
        if (!EXT[type]) throw new Error('not an image (is the link public?)');
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > 4 * 1024 * 1024) throw new Error('over 4 MB');
        const path = `${job.vendor_id}/products/${job.sku.replace(/[^A-Za-z0-9._-]/g, '_')}-${i + 1}.${EXT[type]}`;
        const up = await svc.storage.from('images').upload(path, bytes, { contentType: type, upsert: true });
        if (up.error) throw new Error(up.error.message);
        images.push(svc.storage.from('images').getPublicUrl(path).data.publicUrl + '?v=' + Date.now());
      } catch (e) {
        errs.push(`${u.slice(0, 80)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await svc.rpc('mf_service_image_done', { p: { id: job.id, vendor_id: job.vendor_id, sku: job.sku, urls: job.urls, images, error: errs.join('; ') } });
    done++;
  }
  return done;
}

const actions: Record<string, (req: Request, b: Body) => Promise<Body>> = {
  async adminSyncPreview(req, b) {
    await adminMaps(req, b.vendor);
    const id = sheetId(b.sheet);
    if (!id) throw new Error('Paste the sheet link or ID');
    const info = await meta(id);
    const names = info.tabs.slice(0, 30).map((t) => t.name);
    const data = await readTabs(id, names);
    const all = names.map((n) => ({ name: n, headers: (data[n]?.[0] ?? []).map(String), sample: (data[n] ?? []).slice(1, 4).map((r) => r.map(String)),
                                    rows: Math.max(0, (data[n]?.length ?? 1) - 1) }));
    const tab = b.tab && names.includes(b.tab) ? b.tab : names[0];
    const cur = all.find((t) => t.name === tab)!;
    if (!cur || !cur.headers.length) throw new Error('That tab looks empty');
    return { ok: true, sheet_id: id, tabs: names, all_tabs: all, tab, headers: cur.headers,
             sample: (data[tab] ?? []).slice(1, 6).map((r) => r.map(String)), rows: cur.rows, owner_hint: SERVICE_EMAIL };
  },

  async adminSyncRun(req, b) {
    const me = await adminMaps(req, b.vendor);
    if (!me.maps.length) throw new Error('No mappings yet — add one first');
    const idx = b.index !== undefined && b.index !== null && b.index !== '' ? [Number(b.index)] : me.maps.map((_, i) => i);
    const results = [];
    for (const i of idx) {
      const m = me.maps[i];
      if (!m) continue;
      results.push({ index: i, brand: m.brand, summary: await runMap(me.vendor_id, m, me.actor) });
    }
    await processWriteBacks(me.vendor_id);       // new rows get their Committed / Available straight away
    await processImages();
    return { ok: true, results, maps: (await adminMaps(req, b.vendor)).maps };
  },

  /** Set up the vendor's shared sheet in the standard format and (optionally) link it. */
  async adminSyncTemplate(req, b) {
    const me = await adminMaps(req, b.vendor);
    const id = sheetId(b.sheet);
    if (!id) throw new Error('Create a Google Sheet, share it (Editor) with ' + SERVICE_EMAIL + ', and paste its link here');
    const info = await meta(id);
    const d = await asService().rpc('mf_service_template_data', { p: { vendor_id: me.vendor_id, brand: b.brand || '' } });
    if (d.error) throw new Error(d.error.message);
    const brands: { code: string; name: string }[] = d.data.brands, products: any[] = d.data.products;
    const codes = new Set(brands.map((x) => x.code));
    const tabs: { brand: string; tab: string; rows: any[] }[] = brands.map((x) => ({ brand: x.code, tab: x.name, rows: products.filter((p) => p.brand === x.code) }));
    const loose = products.filter((p) => !codes.has(p.brand));
    if (!b.brand && (loose.length || !brands.length)) tabs.push({ brand: '', tab: 'Stock', rows: loose });

    const existing = new Map(info.tabs.map((t) => [t.name, t.sheetId]));
    const want = ['How to use', ...tabs.map((t) => t.tab)].filter((n) => !existing.has(n));
    await batchUpdate(id, want.map((title) => ({ addSheet: { properties: { title } } })));
    const after = new Map((await meta(id)).tabs.map((t) => [t.name, t.sheetId]));

    await writeRange(id, 'How to use', [
      ['Merchforce stock sheet'],
      ['One tab per brand. Keep the header row exactly as it is; Merchforce finds columns by name.'],
      ['Code is the SKU Merchforce knows. Do not rename a code; add a new row for a new product.'],
      ['Stock is on hand. Merchforce reads it, and writes it back after every order, dispatch and receipt.'],
      ['Committed and Available are filled in by Merchforce: Committed is held for accepted quotes, Available is what you can still promise. Do not edit them. Sell from Available, not Stock.'],
      ['Selling Price Excluding GST sets the first price tier. Deeper tiers are managed in the console.'],
      ['Image URL: one or more public image links, separated by commas (Google Drive and Dropbox share links work if shared with anyone who has the link). Merchforce copies the images in.'],
      ['Leave a cell blank to leave that field alone. Do not add rows above the header, and do not merge cells.'],
      ['Keep this sheet shared (Editor) with ' + SERVICE_EMAIL + ' so Merchforce can read and update it.'],
    ]);
    const fmt: unknown[] = [];
    for (const t of tabs) {
      const sid = after.get(t.tab)!;
      fmt.push({ updateCells: { range: { sheetId: sid }, fields: 'userEnteredValue' } });          // start clean
      fmt.push({ repeatCell: { range: { sheetId: sid, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } }, fields: 'userEnteredFormat.numberFormat' } });
      fmt.push({ repeatCell: { range: { sheetId: sid, startColumnIndex: 2, endColumnIndex: 3 }, cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } }, fields: 'userEnteredFormat.numberFormat' } });
      fmt.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.945, blue: 1 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } });
      fmt.push({ updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
    }
    await batchUpdate(id, fmt);
    for (const t of tabs) {
      await writeRange(id, t.tab, [HEADERS, ...t.rows.map((p) => [String(p.sku), p.name, p.hsn || '', p.gst_rate ?? '', p.mrp ?? '', p.price ?? '',
                                                                   p.on_hand, p.reserved, p.atp, p.moq ?? '', p.lead_time || '', p.images || ''])]);
    }
    // a blank default tab only gets in the way
    const blank = ['Sheet1', 'Sheet 1'].find((n) => after.has(n));
    if (blank && after.size > 1) {
      const rows = (await readTabs(id, [blank]))[blank] ?? [];
      if (!rows.length) await batchUpdate(id, [{ deleteSheet: { sheetId: after.get(blank) } }]);
    }
    let linked = 0, maps = me.maps;
    if (b.link !== false) {
      const l = await asService().rpc('mf_service_template_link', { p: { vendor_id: me.vendor_id, sheet: id, actor: me.actor,
                                                                          tabs: tabs.map((t) => ({ brand: t.brand, tab: t.tab })) } });
      if (l.error) throw new Error(l.error.message);
      linked = tabs.length; maps = l.data.maps;
    }
    return { ok: true, url: 'https://docs.google.com/spreadsheets/d/' + id + '/edit', sheet_id: id, name: info.title,
             linked, shared: '', tabs: tabs.map((t) => t.tab), maps };
  },

  async adminSyncWriteBackAll(req, b) {
    const r = await asCaller(req).rpc('mf_admin_sync_write_back_all', { p: { vendor: b.vendor } });
    if (r.error) throw new Error(r.error.message);
    const out = await processWriteBacks(r.data.vendor_id);
    return { ok: true, written: out.written, errors: out.errors };
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  let body: Body;
  try { body = await req.json(); } catch { return fail('Bad JSON'); }

  if (body.action === 'tick') {                  // pg_cron, once a minute
    if (req.headers.get('x-cron-secret') !== Deno.env.get('MF_CRON_SECRET')) return reply({ ok: false, error: 'Forbidden' }, 403);
    const wb = await processWriteBacks();
    const imported = await processImages();
    const due = await asService().rpc('mf_service_sync_due', { p: {} });
    let pulled = 0;
    for (const v of (due.data?.vendors ?? []) as any[]) {
      for (const m of v.maps as Map[]) { await runMap(v.vendor_id, m, 'auto-sync'); pulled++; }
    }
    if (pulled) await processWriteBacks();
    return reply({ ok: true, written: wb.written, pulled, imported });
  }

  const fn = actions[body.action];
  if (!fn) return fail('Unknown action: ' + body.action);
  try { return reply(await fn(req, body)); }
  catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
});
