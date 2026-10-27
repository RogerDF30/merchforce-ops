// Proforma invoice PDF, drawn with pdf-lib (edge functions cannot render HTML).
// Same content as piHtml_ in the Apps Script version. GST is split CGST + SGST
// when the buyer is in the issuer's own state, IGST otherwise.
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'npm:pdf-lib@1.17.1';

type Row = Record<string, any>;

const INK = rgb(0.086, 0.098, 0.169), MUTED = rgb(0.42, 0.45, 0.5), LINE = rgb(0.84, 0.855, 0.9), HEAD = rgb(0.95, 0.957, 0.98);
const W = 595.28, H = 841.89, M = 36;

// Standard fonts are WinAnsi: anything outside it (₹, →, emoji) would throw.
function clean(s: unknown): string {
  return String(s ?? '').replace(/₹/g, 'Rs.').replace(/→/g, '->').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g, '');
}

export function money(n: unknown): string {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const [i, f] = Math.abs(v).toFixed(2).split('.');
  const last3 = i.slice(-3), rest = i.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return (v < 0 ? '-' : '') + grouped + '.' + f;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of clean(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) out.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {   // a single over-long word
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        out.push(line.slice(0, cut)); line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

async function image(doc: PDFDocument, url: string) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    return png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch { return null; }
}

export async function renderPi(order: Row, lines: Row[], s: Row, states: Record<string, string>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const text = (t: string, x: number, yy: number, size = 9, f = font, color = INK) =>
    page.drawText(clean(t), { x, y: yy, size, font: f, color });
  const right = (t: string, xr: number, yy: number, size = 9, f = font, color = INK) =>
    text(t, xr - f.widthOfTextAtSize(clean(t), size), yy, size, f, color);

  const issuer = s.co_name || s.site_name || 'Merchforce';
  const ex = order.pi_extras || {};
  const supplierCode = String(s.co_state_code || String(s.co_gstin || '').slice(0, 2) || '');
  const buyerCode = String(order.place_of_supply || String(order.gstin || '').match(/^\d{2}/)?.[0] || '');
  const intra = !!supplierCode && supplierCode === buyerCode;

  // ---- header
  const logo = await image(doc, s.co_logo_url);
  let ly = y;
  if (logo) {
    const h = 30, w = (logo.width / logo.height) * h;
    page.drawImage(logo, { x: M, y: ly - h, width: Math.min(w, 160), height: h });
    ly -= h + 6;
  }
  text(issuer, M, ly - 14, 15, bold); ly -= 20;
  for (const l of wrap(s.co_address || '', font, 8.5, 260)) { text(l, M, ly - 9, 8.5, font, MUTED); ly -= 11; }
  const ids = [s.co_gstin ? 'GSTIN: ' + s.co_gstin : '', s.co_pan ? 'PAN: ' + s.co_pan : ''].filter(Boolean).join('  ·  ');
  if (ids) { text(ids, M, ly - 9, 8.5, font, MUTED); ly -= 11; }
  const contact = [s.co_phone, s.co_email].filter(Boolean).join('  ·  ');
  if (contact) { text(contact, M, ly - 9, 8.5, font, MUTED); ly -= 11; }

  let ry = y;
  right('PROFORMA INVOICE', W - M, ry - 14, 15, bold); ry -= 22;
  right(order.pi_number || '', W - M, ry - 10, 10, bold); ry -= 14;
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  right('Date: ' + today, W - M, ry - 9, 8.5, font, MUTED); ry -= 11;
  if (order.pi_valid_till) { right('Valid till: ' + order.pi_valid_till, W - M, ry - 9, 8.5, font, MUTED); ry -= 11; }
  right('Ref: ' + order.number, W - M, ry - 9, 8.5, font, MUTED); ry -= 11;

  y = Math.min(ly, ry) - 8;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.5, color: INK });
  y -= 14;

  // ---- bill to / ship to
  const boxW = (W - 2 * M - 12) / 2;
  const bill = [order.company, [order.contact, order.phone].filter(Boolean).join(' · '), order.email, order.gstin ? 'GSTIN: ' + order.gstin : ''].filter(Boolean);
  const ship = [...(order.ship_address ? wrap(order.ship_address, font, 8.5, boxW - 16) : ['Same as billing']),
                'Place of supply: ' + (states[buyerCode] || buyerCode || '—')];
  const boxH = 22 + Math.max(bill.length, ship.length) * 11;
  for (const [i, title, rows] of [[0, 'Bill to', bill], [1, 'Ship to', ship]] as [number, string, string[]][]) {
    const x = M + i * (boxW + 12);
    page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, borderColor: LINE, borderWidth: 1 });
    text(title, x + 8, y - 14, 9, bold);
    rows.forEach((r, k) => text(r, x + 8, y - 27 - k * 11, 8.5, k === 0 && i === 0 ? font : font, k === 0 && i === 0 ? INK : MUTED));
  }
  y -= boxH + 14;

  // ---- line table
  const cols = [
    { h: '#', w: 18, a: 'c' }, { h: 'DESCRIPTION', w: 186, a: 'l' }, { h: 'HSN', w: 50, a: 'c' }, { h: 'QTY', w: 38, a: 'r' },
    { h: 'RATE', w: 62, a: 'r' }, { h: 'AMOUNT', w: 72, a: 'r' }, { h: 'GST', w: 35, a: 'c' }, { h: 'TAX', w: 62, a: 'r' },
  ];
  const tableHead = () => {
    page.drawRectangle({ x: M, y: y - 16, width: W - 2 * M, height: 16, color: HEAD, borderColor: LINE, borderWidth: 1 });
    let x = M;
    for (const c of cols) {
      const tx = c.a === 'r' ? x + c.w - 4 - bold.widthOfTextAtSize(c.h, 7.5) : c.a === 'c' ? x + (c.w - bold.widthOfTextAtSize(c.h, 7.5)) / 2 : x + 4;
      text(c.h, tx, y - 11, 7.5, bold, MUTED); x += c.w;
    }
    y -= 16;
  };
  tableHead();

  let sub = 0, taxTotal = 0;
  lines.forEach((l, i) => {
    const qty = Number(l.qty || 0), rate = Number(l.unit_price || 0), amt = qty * rate, gst = Number(l.gst || 0), tax = amt * gst / 100;
    sub += amt; taxTotal += tax;
    const desc = wrap(l.name || '', font, 8.5, cols[1].w - 8);
    const rowH = 8 + desc.length * 10.5 + 10;
    if (y - rowH < 150) {                         // new page, header row repeated
      page = doc.addPage([W, H]); y = H - M; tableHead();
    }
    page.drawRectangle({ x: M, y: y - rowH, width: W - 2 * M, height: rowH, borderColor: LINE, borderWidth: 0.75 });
    const vals = [String(i + 1), '', l.hsn || '', String(qty), money(rate), money(amt), gst + '%', money(tax)];
    let x = M;
    cols.forEach((c, k) => {
      if (k === 1) {
        desc.forEach((d, j) => text(d, x + 4, y - 12 - j * 10.5, 8.5));
        text(String(l.sku || ''), x + 4, y - 12 - desc.length * 10.5, 7.5, font, MUTED);
      } else {
        const v = clean(vals[k]);
        const tx = c.a === 'r' ? x + c.w - 4 - font.widthOfTextAtSize(v, 8.5) : c.a === 'c' ? x + (c.w - font.widthOfTextAtSize(v, 8.5)) / 2 : x + 4;
        text(v, tx, y - 12, 8.5);
      }
      x += c.w;
    });
    y -= rowH;
  });

  // ---- totals
  const freight = Number(ex.freight || 0), discount = Number(ex.discount || 0);
  const grand = sub + taxTotal + freight - discount;
  const tot: [string, string, boolean][] = [['Subtotal', money(sub), false]];
  if (intra) { tot.push(['CGST', money(taxTotal / 2), false], ['SGST', money(taxTotal / 2), false]); }
  else tot.push(['IGST', money(taxTotal), false]);
  if (freight) tot.push(['Freight / handling', money(freight), false]);
  if (discount) tot.push(['Discount', '-' + money(discount), false]);
  tot.push(['Total (INR)', money(grand), true]);
  if (y - tot.length * 15 - 120 < M) { page = doc.addPage([W, H]); y = H - M; }
  y -= 8;
  for (const [label, val, strong] of tot) {
    if (strong) { page.drawLine({ start: { x: W - M - 200, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 1, color: INK }); y -= 4; }
    right(label, W - M - 90, y - 10, strong ? 11 : 9, strong ? bold : font, strong ? INK : MUTED);
    right(val, W - M - 4, y - 10, strong ? 11 : 9, strong ? bold : font);
    y -= strong ? 18 : 14;
  }

  // ---- terms, bank, notes, signature
  y -= 10;
  const notes: [string, string][] = [];
  if (s.co_bank) notes.push(['Bank details', s.co_bank]);
  if (s.co_terms) notes.push(['Terms', s.co_terms]);
  if (ex.notes) notes.push(['Notes', ex.notes]);
  const leftW = (W - 2 * M) * 0.6;
  let ny = y;
  for (const [h, body] of notes) {
    if (ny < M + 60) { page = doc.addPage([W, H]); ny = H - M; }
    text(h, M, ny - 9, 8.5, bold); ny -= 12;
    for (const l of wrap(body, font, 8, leftW)) { text(l, M, ny - 8, 8, font, MUTED); ny -= 10; }
    ny -= 6;
  }
  for (const l of wrap('This is a proforma invoice, not a tax invoice. Stock is subject to prior sale until this proforma is accepted.', font, 7.5, leftW)) {
    text(l, M, ny - 8, 7.5, font, MUTED); ny -= 9.5;
  }
  const sign = await image(doc, s.co_sign_url);
  const sx = W - M - 160;
  let sy = y;
  if (sign) {
    const h = 40, w = Math.min(150, (sign.width / sign.height) * h);
    page.drawImage(sign, { x: sx + (160 - w) / 2, y: sy - h, width: w, height: h });
    sy -= h + 4;
  } else sy -= 40;
  const forLine = clean('For ' + issuer);
  text(forLine, sx + (160 - font.widthOfTextAtSize(forLine, 8.5)) / 2, sy - 10, 8.5);
  text('Authorised signatory', sx + (160 - font.widthOfTextAtSize('Authorised signatory', 8.5)) / 2, sy - 21, 8.5, font, MUTED);

  return await doc.save();
}
