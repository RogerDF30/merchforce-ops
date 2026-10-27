// Files for the console and the customer's order page.
//
// The console sends files as data URLs, as it did to Apps Script; this
// function stores them under the vendor's folder and records them through
// the same SQL actions, which do all the business checks. Lists that carry
// file paths come back with short-lived signed links (pi_url, po_url,
// doc_url, file url), so private documents never get a permanent public URL.
import { asCaller, asService, cors, fail, reply } from '../_shared/http.ts';
import { renderPi } from '../_shared/pi_pdf.ts';
import { buildPptx, prefetchImages } from '../_shared/deck_pptx.ts';
import { buildDeckPdf } from '../_shared/deck_pdf.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const LINK_SECONDS = 60 * 60;          // signed links last an hour
const MAX_DOC = 10 * 1024 * 1024, MAX_IMAGE = 4 * 1024 * 1024;

type Body = Record<string, any>;

function decode(data: string): Uint8Array {
  const b64 = String(data || '').replace(/^data:[^;]+;base64,/, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function safeName(name: string): string {
  return String(name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(-120) || 'file';
}

async function store(bucket: string, path: string, bytes: Uint8Array, mime: string) {
  const up = await asService().storage.from(bucket).upload(path, bytes, { contentType: mime || 'application/octet-stream', upsert: true });
  if (up.error) throw new Error('Could not store the file: ' + up.error.message);
}

async function sign(paths: string[]): Promise<Record<string, string>> {
  const want = [...new Set(paths.filter(Boolean))];
  if (!want.length) return {};
  const res = await asService().storage.from('docs').createSignedUrls(want, LINK_SECONDS);
  const out: Record<string, string> = {};
  for (const r of res.data ?? []) if (r.path && r.signedUrl) out[r.path] = r.signedUrl;
  return out;
}

async function withOrderLinks(order: Body) {
  const urls = await sign([order.pi_path, order.po_path]);
  order.pi_url = urls[order.pi_path] ?? '';
  order.po_url = urls[order.po_path] ?? '';
  return order;
}

/** Calls an mf_* SQL action as the caller; SQL errors become {ok:false}. */
async function sql(client: ReturnType<typeof asCaller>, action: string, p: Body) {
  const r = await client.rpc('mf_' + action.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()), { p });
  if (r.error) throw new Error(r.error.message);
  if (r.data && r.data.ok === false) throw new Error(r.data.error);
  return r.data;
}

/** The vendor to store under, once the caller is confirmed allowed to write (view-only admins are refused here, before any upload). */
async function vendorId(caller: ReturnType<typeof asCaller>, body: Body): Promise<string> {
  return (await sql(caller, 'canWrite', { vendor: body.vendor })).vendor_id;
}

/** Render the PI for an order and record where it is kept. */
async function buildPdf(vid: string, number: string): Promise<string> {
  const svc = asService();
  const d = await svc.rpc('mf_service_pi_data', { p: { vendor_id: vid, number } });
  if (d.error || !d.data) throw new Error('Could not read the order for its PDF');
  const bytes = await renderPi(d.data.order, d.data.lines, d.data.settings, d.data.states ?? {});
  const path = `${vid}/orders/${number}/${safeName(d.data.order.pi_number || 'PI')}.pdf`;
  await store('docs', path, bytes, 'application/pdf');
  await svc.rpc('mf_service_set_pi_path', { p: { vendor_id: vid, number, path } });
  return path;
}

const actions: Record<string, (req: Request, b: Body) => Promise<Body>> = {
  // ---- lists, with signed links
  async adminOrders(req, b) {
    const out = await sql(asCaller(req), 'adminOrders', b);
    const urls = await sign(out.orders.flatMap((o: Body) => [o.pi_path, o.po_path]));
    for (const o of out.orders) { o.pi_url = urls[o.pi_path] ?? ''; o.po_url = urls[o.po_path] ?? ''; }
    return out;
  },
  async orderView(_req, b) {
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } });
    const out = await sql(anon as any, 'orderView', b);
    await withOrderLinks(out.order);
    return out;
  },
  async adminReturns(req, b) {
    const out = await sql(asCaller(req), 'adminReturns', b);
    const urls = await sign(out.returns.map((x: Body) => x.doc_path));
    for (const x of out.returns) x.doc_url = urls[x.doc_path] ?? '';
    return out;
  },
  async adminAccountNotes(req, b) {
    const out = await sql(asCaller(req), 'adminAccountNotes', b);
    const urls = await sign(out.files.map((f: Body) => f.path));
    for (const f of out.files) f.url = urls[f.path] ?? '';
    return out;
  },

  // ---- proforma invoice
  async adminPiBuild(req, b) {
    const caller = asCaller(req);
    const out = await sql(caller, 'adminPiBuild', b);
    const vid = await vendorId(caller, b);
    const path = await buildPdf(vid, b.id);
    out.pi_path = path;
    out.pi_url = (await sign([path]))[path] ?? '';
    return out;
  },
  async adminPiUpload(req, b) {
    const caller = asCaller(req);
    const vid = await vendorId(caller, b);
    const bytes = decode(b.data);
    if (!b.data || !b.filename) throw new Error('data + filename required');
    if (bytes.length > MAX_DOC) throw new Error('File over 10MB');
    const path = `${vid}/orders/${safeName(b.id)}/pi-${safeName(b.filename)}`;
    await store('docs', path, bytes, b.mime || 'application/pdf');
    const out = await sql(caller, 'adminPiUpload', { ...b, data: undefined, path });
    out.pi_url = (await sign([path]))[path] ?? '';
    return out;
  },

  // ---- purchase orders
  async adminPoUpload(req, b) {
    const caller = asCaller(req);
    const vid = await vendorId(caller, b);
    const bytes = decode(b.data);
    if (!b.data || !b.filename) throw new Error('data + filename required');
    if (bytes.length > MAX_DOC) throw new Error('File over 10MB');
    const path = `${vid}/orders/${safeName(b.id)}/po-${safeName(b.filename)}`;
    await store('docs', path, bytes, b.mime || 'application/pdf');
    const out = await sql(caller, 'adminPoUpload', { ...b, data: undefined, path });
    out.po_url = (await sign([path]))[path] ?? '';
    return out;
  },
  async orderPoUpload(_req, b) {
    const svc = asService();
    const who = await svc.rpc('mf_service_order_by_token', { p: { t: b.t } });
    if (who.error || !who.data?.ok) throw new Error(who.data?.error || 'This order link is not valid');
    if (!['PI Accepted', 'PO Received'].includes(who.data.status)) throw new Error('Accept the proforma invoice before sending a purchase order');
    if (!b.data || !b.filename) throw new Error('Attach the purchase order file');
    const bytes = decode(b.data);
    if (bytes.length > MAX_DOC) throw new Error('File over 10MB');
    const path = `${who.data.vendor_id}/orders/${who.data.number}/po-${safeName(b.filename)}`;
    await store('docs', path, bytes, b.mime || 'application/pdf');
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } });
    const out = await sql(anon as any, 'orderPoUpload', { t: b.t, po_number: b.po_number, path });
    out.po_url = (await sign([path]))[path] ?? '';
    return out;
  },

  // ---- returns: credit note / refund document on close
  async adminReturnClose(req, b) {
    const caller = asCaller(req);
    await vendorId(caller, b);
    let path = '';
    if (b.data && b.filename) {
      const vid = await vendorId(caller, b);
      const bytes = decode(b.data);
      if (bytes.length > MAX_DOC) throw new Error('File over 10MB');
      path = `${vid}/returns/${safeName(b.id)}-${safeName(b.filename)}`;
      await store('docs', path, bytes, b.mime || 'application/pdf');
    }
    const out = await sql(caller, 'adminReturnClose', { ...b, data: undefined, filename: undefined, path });
    out.doc_url = path ? (await sign([path]))[path] ?? '' : '';
    return out;
  },

  // ---- account attachments
  async adminAccountFileUpload(req, b) {
    const caller = asCaller(req);
    const vid = await vendorId(caller, b);
    if (!b.data || !b.filename) throw new Error('data + filename required');
    const bytes = decode(b.data);
    if (bytes.length > MAX_DOC) throw new Error('File over 10MB');
    const path = `${vid}/accounts/${safeName(b.company_id)}/${crypto.randomUUID().slice(0, 8)}-${safeName(b.filename)}`;
    await store('docs', path, bytes, b.mime || 'application/octet-stream');
    const out = await sql(caller, 'adminAccountFileSave', { vendor: b.vendor, company_id: b.company_id, path,
                                                            name: String(b.filename).slice(0, 120), mime: b.mime, size: bytes.length });
    out.file.url = (await sign([path]))[path] ?? '';
    return out;
  },
  async adminAccountFileDelete(req, b) {
    const out = await sql(asCaller(req), 'adminAccountFileDelete', b);
    if (out.path) await asService().storage.from('docs').remove([out.path]);
    return { ok: true };
  },

  // ---- product decks (PDF + PPTX)
  async adminDecks(req, b) {
    const out = await sql(asCaller(req), 'adminDecks', b);
    const urls = await sign(out.decks.flatMap((d: Body) => [d.pdf_path, d.pptx_path]));
    for (const d of out.decks) { d.pdf_url = urls[d.pdf_path] ?? ''; d.pptx_url = urls[d.pptx_path] ?? ''; }
    return out;
  },
  async adminDeckBuild(req, b) {
    const prep = await sql(asCaller(req), 'adminDeckPrepare', b);
    const svc = asService();
    const deck = { name: prep.name, company: prep.company };
    const cache: Record<string, any> = {};
    try {
      await prefetchImages([prep.settings.co_logo_url, ...prep.products.map((p: Body) => p.image)], cache);
      const pdf = await buildDeckPdf(deck, prep.products, prep.settings, cache);
      const pptx = buildPptx(deck, prep.products, prep.settings, cache);
      const base = `${prep.vendor_id}/decks/${prep.id}/${safeName(prep.name)}`;
      await store('docs', base + '.pdf', pdf, 'application/pdf');
      await store('docs', base + '.pptx', pptx, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      await svc.rpc('mf_service_deck_files', { p: { vendor_id: prep.vendor_id, id: prep.id, pdf_path: base + '.pdf', pptx_path: base + '.pptx',
                                                   count: prep.products.length } });
      const urls = await sign([base + '.pdf', base + '.pptx']);
      return { ok: true, id: prep.id, pdf_url: urls[base + '.pdf'] ?? '', pptx_url: urls[base + '.pptx'] ?? '',
               products: prep.products.length, missing: prep.missing };
    } catch (e) {
      await svc.rpc('mf_service_deck_files', { p: { vendor_id: prep.vendor_id, id: prep.id, pdf_path: '' } });   // no half-made deck
      throw e;
    }
  },
  async adminDeckSend(req, b) {
    const caller = asCaller(req);
    const list = await sql(caller, 'adminDecks', { vendor: b.vendor });
    const d = list.decks.find((x: Body) => x.id === b.id);
    if (!d) throw new Error('Deck not found');
    // emailed links must outlive the session: 30 days
    const res = await asService().storage.from('docs').createSignedUrls([d.pdf_path, d.pptx_path], 30 * 24 * 3600);
    const [pdf, pptx] = (res.data ?? []).map((x) => x.signedUrl ?? '');
    return await sql(caller, 'adminDeckSend', { ...b, pdf_url: pdf, pptx_url: pptx });
  },
  async adminDeckDelete(req, b) {
    const out = await sql(asCaller(req), 'adminDeckDelete', b);
    const paths = (out.paths as string[]).filter(Boolean);
    if (paths.length) await asService().storage.from('docs').remove(paths);
    return { ok: true, id: out.id };
  },

  // ---- product images, logos, signatures: public bucket
  async adminImageUpload(req, b) {
    const caller = asCaller(req);
    const vid = await vendorId(caller, b);
    if (!b.data || !b.filename) throw new Error('data + filename required');
    const bytes = decode(b.data);
    if (bytes.length > MAX_IMAGE) throw new Error('Image over 4MB');
    const path = `${vid}/images/${crypto.randomUUID().slice(0, 8)}-${safeName(b.filename)}`;
    await store('images', path, bytes, b.mime || 'image/png');
    const url = asService().storage.from('images').getPublicUrl(path).data.publicUrl;
    return { ok: true, url, file_id: path };
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  let body: Body;
  try { body = await req.json(); } catch { return fail('Bad JSON'); }
  const fn = actions[body.action];
  if (!fn) return fail('Unknown action: ' + body.action);
  try {
    return reply(await fn(req, body));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
});
