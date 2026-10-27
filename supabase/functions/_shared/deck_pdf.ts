// Product deck PDF (A4 portrait), drawn with pdf-lib. Same content and layout
// rules as the Apps Script HTML deck: cover, product cards (compact: two a
// page, spacious: one), and an at-a-glance table, in the vendor's deck colours.
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'npm:pdf-lib@1.17.1';
import { clip_, deckTheme, factsText_, fromPrice_, stockText_ } from './deck_pptx.ts';
import { money } from './pi_pdf.ts';

const W = 595.28, H = 841.89, M = 40;
type P = Record<string, any>;

const hex = (h: string) => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
function clean(s: unknown): string {
  return String(s ?? '').replace(/₹/g, 'Rs.').replace(/→/g, '->').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g, '');
}
function wrap(text: string, font: PDFFont, size: number, width: number, maxLines = 99): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of clean(text).split(/\s+/)) {
    const next = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
    if (line) out.push(line);
    line = word;
  }
  if (line) out.push(line);
  if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] = out[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
  return out;
}

export async function buildDeckPdf(deck: P, products: P[], s: P, cache: Record<string, any>): Promise<Uint8Array> {
  const T = deckTheme(s);
  const compact = T.layout === 'compact', per = compact ? 2 : 1;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = hex(T.ink), muted = hex(T.muted), accent = hex(T.accent), plate = hex(T.plate), line = hex(T.line);
  const ok = hex(T.ok), warn = hex(T.warn);
  const coName = s.co_name || s.site_name || 'Merchforce';
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const footNote = 'Prices in INR, exclusive of GST  ·  Stock as at ' + today;
  const SUMMARY_ROWS = 28;
  const pages = 1 + Math.ceil(products.length / per) + Math.ceil(products.length / SUMMARY_ROWS);
  const embedded: Record<string, any> = {};
  const img = async (url: string) => {
    const c = url && cache[url];
    if (!c) return null;
    if (!embedded[url]) {
      try { embedded[url] = c.ext === 'png' ? await doc.embedPng(c.bytes) : await doc.embedJpg(c.bytes); } catch { embedded[url] = null; }
    }
    return embedded[url];
  };
  let page: PDFPage;
  const text = (t: string, x: number, y: number, size: number, f = font, color = ink) => page.drawText(clean(t), { x, y, size, font: f, color });
  const right = (t: string, xr: number, y: number, size: number, f = font, color = ink) => text(t, xr - f.widthOfTextAtSize(clean(t), size), y, size, f, color);
  const chrome = (n: number) => {
    text(coName.toUpperCase(), M, H - M + 6, 7, bold, muted);
    right(deck.name.toUpperCase(), W - M, H - M + 6, 7, bold, muted);
    page.drawLine({ start: { x: M, y: H - M }, end: { x: W - M, y: H - M }, thickness: 0.4, color: line });
    text(footNote, M, M - 18, 7, font, muted);
    right(n + ' / ' + pages, W - M, M - 18, 7, font, muted);
  };

  // ---- cover
  page = doc.addPage([W, H]);
  page.drawRectangle({ x: 0, y: H - 4, width: W, height: 4, color: accent });
  const logo = await img(s.co_logo_url);
  if (logo) {
    const h = 44, w = Math.min(190, (logo.width / logo.height) * h);
    page.drawImage(logo, { x: M + 14, y: H - 120, width: w, height: h });
  }
  page.drawRectangle({ x: M + 14, y: H * 0.56, width: 36, height: 4, color: accent });
  text(coName.toUpperCase() + '   ·   PRODUCT DECK', M + 14, H * 0.56 - 22, 9, bold, accent);
  let cy = H * 0.56 - 60;
  for (const l of wrap(deck.name, bold, 32, W - 2 * M - 28, 3)) { text(l, M + 14, cy, 32, bold); cy -= 38; }
  text((deck.company ? 'Prepared for ' + deck.company + '   ·   ' : '') + today + '   ·   ' + products.length + ' product' + (products.length === 1 ? '' : 's'),
       M + 14, cy - 8, 12, font, muted);
  let fy = M + 30;
  for (const l of wrap([coName, s.co_address, s.co_gstin ? 'GSTIN ' + s.co_gstin : '', s.co_phone, s.co_email].filter(Boolean).join('   ·   '), font, 8, W - 2 * M - 28, 3).reverse()) {
    text(l, M + 14, fy, 8, font, muted); fy += 11;
  }
  text(footNote, M + 14, M + 16, 8, font, muted);

  // ---- product pages
  const cardH = compact ? (H - 2 * M - 20) / 2 : H - 2 * M - 20;
  const plateS = compact ? 198 : 272;
  for (let i = 0, n = 2; i < products.length; i += per, n++) {
    page = doc.addPage([W, H]);
    chrome(n);
    for (let j = 0; j < per && i + j < products.length; j++) {
      const p = products[i + j];
      const top = H - M - 14 - j * cardH;
      if (j > 0) page.drawLine({ start: { x: M, y: top + 8 }, end: { x: W - M, y: top + 8 }, thickness: 0.4, color: line });
      page.drawRectangle({ x: M, y: top - plateS, width: plateS, height: plateS, color: plate });
      const im = await img(p.image);
      if (im) {
        const pad = 12, k = Math.min((plateS - 2 * pad) / im.width, (plateS - 2 * pad) / im.height);
        page.drawImage(im, { x: M + (plateS - im.width * k) / 2, y: top - plateS + (plateS - im.height * k) / 2, width: im.width * k, height: im.height * k });
      } else {
        text('No image', M + plateS / 2 - font.widthOfTextAtSize('No image', 9) / 2, top - plateS / 2, 9, font, muted);
      }
      const x = M + plateS + 22, colW = W - M - x;
      let y = top - 10;
      const eyebrow = [p.brand, p.category].filter(Boolean).join(' · ').toUpperCase();
      if (eyebrow) { text(eyebrow, x, y, 7.5, bold, accent); y -= 16; }
      for (const l of wrap(p.name, bold, compact ? 15 : 19, colW, 3)) { text(l, x, y, compact ? 15 : 19, bold); y -= compact ? 18 : 23; }
      text(p.sku + (p.hsn ? ' · HSN ' + p.hsn : ''), x, y, 8, font, muted); y -= 16;
      for (const sp of (p.specs as string[]).slice(0, compact ? 5 : 8)) {
        const ls = wrap(clip_(sp, compact ? 110 : 160), font, 8.5, colW - 10, 2);
        ls.forEach((l, k) => { if (k === 0) page.drawCircle({ x: x + 2.5, y: y + 3, size: 1.4, color: muted }); text(l, x + 9, y, 8.5); y -= 11; });
        y -= 2;
      }
      y -= 4;
      text(factsText_(p).replace(/ {3}· {3}/g, '  ·  '), x, y, 8, font, muted); y -= 18;
      if (p.tiers.length) {
        const tw = Math.min(colW, 230);
        page.drawRectangle({ x, y: y - 4, width: tw, height: 16, color: plate });
        text('QUANTITY', x + 6, y + 1, 7, bold, muted); right('UNIT PRICE', x + tw - 6, y + 1, 7, bold, muted);
        y -= 18;
        for (const t of p.tiers.slice(0, compact ? 4 : 6)) {
          text(t.min.toLocaleString('en-IN') + '+', x + 6, y, 9);
          right('Rs. ' + money(t.price), x + tw - 6, y, 9, bold);
          page.drawLine({ start: { x, y: y - 5 }, end: { x: x + tw, y: y - 5 }, thickness: 0.3, color: line });
          y -= 15;
        }
        if (p.mrp) { text('MRP Rs. ' + money(p.mrp), x + 6, y - 2, 7.5, font, muted); y -= 14; }
      }
      text(stockText_(p), x, Math.max(y - 6, top - cardH + 30), 9, bold, p.atp > 0 ? ok : warn);
    }
  }

  // ---- at a glance
  const cols = [{ h: 'SKU', w: 80 }, { h: 'PRODUCT', w: 205 }, { h: 'MOQ', w: 45, r: true }, { h: 'LEAD TIME', w: 70 }, { h: 'FROM', w: 60, r: true }, { h: 'STOCK', w: 55, r: true }];
  for (let i = 0, n = 2 + Math.ceil(products.length / per); i < products.length; i += SUMMARY_ROWS, n++) {
    page = doc.addPage([W, H]);
    chrome(n);
    let y = H - M - 34;
    text('At a glance', M, y, 15, bold); y -= 24;
    page.drawRectangle({ x: M, y: y - 5, width: W - 2 * M, height: 17, color: plate });
    let x = M;
    for (const c of cols) { c.r ? right(c.h, x + c.w - 4, y, 7, bold, muted) : text(c.h, x + 4, y, 7, bold, muted); x += c.w; }
    y -= 20;
    for (const p of products.slice(i, i + SUMMARY_ROWS)) {
      const vals = [p.sku, clip_(p.name, 46), String(p.moq), p.lead_time || '—',
                    fromPrice_(p) ? 'Rs. ' + money(fromPrice_(p)) : '—', p.atp > 0 ? p.atp.toLocaleString('en-IN') : 'MTO'];
      x = M;
      cols.forEach((c, k) => { c.r ? right(vals[k], x + c.w - 4, y, 8) : text(vals[k], x + 4, y, 8, k === 1 ? font : font, k === 0 ? muted : ink); x += c.w; });
      page.drawLine({ start: { x: M, y: y - 6 }, end: { x: W - M, y: y - 6 }, thickness: 0.3, color: line });
      y -= 21;
    }
  }
  return await doc.save();
}
