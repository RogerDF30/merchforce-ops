/**
 * Product decks, ported from apps-script/Decks.gs.
 *
 * PDF is the same HTML and CSS as before, rendered by the same headless browser
 * that produces the proforma. PPTX was hand-written OOXML -- several hundred
 * lines of XML string building -- and is rebuilt on pptxgenjs, which produces
 * the same slide plan without anyone maintaining the zip format by hand.
 */

export interface DeckProduct {
  sku: string;
  name: string;
  brand: string;
  category: string;
  description: string;
  specs: string[];
  image: string;
  moq: number;
  gst: number;
  hsn: string;
  leadTime: string;
  mrp: number;
  atp: number;
  tiers: { min: number; price: number }[];
}

export interface DeckTheme {
  accent: string; ink: string; muted: string; plate: string;
  line: string; ok: string; warn: string;
  layout: 'compact' | 'spacious';
}

/** Colours come from Settings so a supplier can brand their own decks. */
export function deckTheme(s: Record<string, string>): DeckTheme {
  const hex6 = (v: string | undefined, fallback: string): string => {
    const m = String(v ?? '').trim().replace(/^#/, '');
    return /^[0-9a-fA-F]{6}$/.test(m) ? m.toUpperCase() : fallback;
  };
  return {
    accent: hex6(s.deck_accent, '2447F5'),
    ink: hex6(s.deck_ink, '1D1D1F'),
    muted: hex6(s.deck_muted, '6E6E73'),
    plate: hex6(s.deck_plate, 'F5F5F7'),
    line: 'E5E5EA', ok: '248A3D', warn: 'B25000',
    layout: s.deck_layout === 'spacious' ? 'spacious' : 'compact',
  };
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;
const nfmt = (n: number): string => n.toLocaleString('en-IN');

const clip = (str: string, n: number): string =>
  str.length > n ? `${str.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : str;

export const fromPrice = (p: DeckProduct): number => p.tiers[0]?.price ?? 0;

export const stockText = (p: DeckProduct): string =>
  p.atp > 0 ? `In stock · ${nfmt(p.atp)} available` : 'Made to order';

export const factsText = (p: DeckProduct): string =>
  `MOQ ${p.moq}${p.leadTime ? `   ·   Lead time ${p.leadTime}` : ''}   ·   GST ${p.gst}%`;

const dmy = (d: Date): string =>
  d.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });

// ---------------------------------------------------------------------- PDF

export function deckHtml(
  deck: { name: string; company: string },
  products: DeckProduct[],
  s: Record<string, string>,
): string {
  const T = deckTheme(s);
  const compact = T.layout === 'compact';
  const per = compact ? 2 : 1;
  const today = dmy(new Date());
  const coName = s.co_name || s.site_name || 'Merchforce';
  const footNote = `Prices in INR, exclusive of GST  ·  Stock as at ${today}`;
  const c = (h: string): string => `#${h}`;

  const productPages = Math.ceil(products.length / per);
  const SUMMARY_ROWS = 28;
  const summaryPages = Math.ceil(products.length / SUMMARY_ROWS);
  const pages = 1 + productPages + summaryPages;

  const css = `<style>
@page{size:A4;margin:14mm 16mm 16mm}
body{font-family:Helvetica,Arial,sans-serif;color:${c(T.ink)};margin:0;font-size:10pt;line-height:1.35}
.pg{page-break-after:always}.pg:last-child{page-break-after:auto}
.hdr{display:flex;justify-content:space-between;color:${c(T.muted)};font-size:7.5pt;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border-bottom:.4pt solid ${c(T.line)};padding-bottom:2.5mm;margin-bottom:6mm}
.ftr{display:flex;justify-content:space-between;color:${c(T.muted)};font-size:7.5pt;margin-top:6mm;border-top:.4pt solid ${c(T.line)};padding-top:2.5mm}
.eyebrow{color:${c(T.accent)};font-weight:700;font-size:7.5pt;letter-spacing:.08em;text-transform:uppercase}
.rule{width:12mm;height:1.2mm;background:${c(T.accent)};margin-bottom:4mm}
.cover{padding-top:58mm}.cover h1{font-size:30pt;margin:3mm 0 4mm;line-height:1.08;font-weight:700}.cover .meta{color:${c(T.muted)};font-size:11.5pt}
.cover .who{color:${c(T.muted)};font-size:8.5pt;margin-top:70mm;line-height:1.6}
.card{display:flex;gap:9mm;padding:${compact ? '6mm 0 0' : '4mm 0'};height:${compact ? '112mm' : '228mm'};box-sizing:border-box;border-bottom:.4pt solid ${c(T.line)}}.card:last-of-type{border-bottom:none}
.plate{width:${compact ? '70mm' : '96mm'};height:${compact ? '70mm' : '96mm'};display:flex;align-items:center;justify-content:center;background:${c(T.plate)};border-radius:3mm;flex:none}
.plate img{max-width:${compact ? '60mm' : '84mm'};max-height:${compact ? '60mm' : '84mm'}}
.body{flex:1;min-width:0}.name{font-size:${compact ? '15pt' : '20pt'};font-weight:700;margin:1.5mm 0 .8mm;line-height:1.15}.sku{color:${c(T.muted)};font-size:8.5pt;margin-bottom:3mm}
ul{margin:0 0 3.5mm 3.5mm;padding:0;font-size:${compact ? '9.3pt' : '10pt'}}li{margin-bottom:.9mm}
.facts{font-weight:700;font-size:${compact ? '9.5pt' : '10.5pt'};margin:1mm 0 2.5mm}
.tiers{border-collapse:collapse;margin:0 0 2.5mm}.tiers th{text-align:left;font-weight:400;color:${c(T.muted)};font-size:7.5pt;padding:0 7mm .8mm 0;border-bottom:.4pt solid ${c(T.line)}}
.tiers td{font-weight:700;font-size:${compact ? '12pt' : '13pt'};padding:1.2mm 8mm 0 0}
.stock{font-weight:700;font-size:${compact ? '9.5pt' : '10.5pt'}}.ok{color:${c(T.ok)}}.mto{color:${c(T.warn)}}
h2{font-size:16pt;margin:0 0 5mm}
.sum{width:100%;border-collapse:collapse;font-size:8.8pt}.sum th{text-align:left;color:${c(T.muted)};font-weight:700;font-size:7.5pt;text-transform:uppercase;letter-spacing:.05em;padding:0 3mm 1.5mm 0;border-bottom:.6pt solid ${c(T.ink)}}
.sum td{padding:1.6mm 3mm 1.6mm 0;border-bottom:.4pt solid ${c(T.line)};vertical-align:top}.num{text-align:right}
</style>`;

  const header = (): string =>
    `<div class="hdr"><span>${esc(coName)}</span><span>${esc(deck.name)}</span></div>`;
  const footer = (n: number): string =>
    `<div class="ftr"><span>${esc(footNote)}</span><span>${n} / ${pages}</span></div>`;

  let html = `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>`;

  html +=
    `<div class="pg cover">` +
    (s.co_logo_url
      ? `<img src="${esc(s.co_logo_url)}" style="height:20mm;margin-bottom:10mm"><br>`
      : '') +
    `<div class="rule"></div><div class="eyebrow">${esc(coName)} · Product deck</div>` +
    `<h1>${esc(deck.name)}</h1>` +
    `<div class="meta">${deck.company ? `Prepared for ${esc(deck.company)} · ` : ''}${today} · ${products.length} product${products.length === 1 ? '' : 's'}</div>` +
    `<div class="who">${esc(
      [coName, s.co_address, s.co_gstin ? `GSTIN ${s.co_gstin}` : '', s.co_phone, s.co_email]
        .filter(Boolean)
        .join(' · '),
    )}<br>${esc(footNote)}</div></div>`;

  for (let pi = 0; pi < productPages; pi++) {
    html += `<div class="pg">${header()}`;
    for (const p of products.slice(pi * per, pi * per + per)) {
      html +=
        `<div class="card"><div class="plate">` +
        (p.image ? `<img src="${esc(p.image)}">` : '') +
        `</div><div class="body">` +
        `<div class="eyebrow">${esc([p.brand, p.category].filter(Boolean).join(' · '))}</div>` +
        `<div class="name">${esc(p.name)}</div>` +
        `<div class="sku">${esc(p.sku)}${p.hsn ? ` · HSN ${esc(p.hsn)}` : ''}</div>` +
        (p.specs.length
          ? `<ul>${p.specs
              .slice(0, compact ? 5 : 8)
              .map((x) => `<li>${esc(clip(x, compact ? 110 : 160))}</li>`)
              .join('')}</ul>`
          : '') +
        `<div class="facts">${esc(factsText(p)).replace(/ {3}· {3}/g, ' &nbsp;·&nbsp; ')}</div>` +
        (p.tiers.length
          ? `<table class="tiers"><tr>${p.tiers
              .slice(0, 4)
              .map((t) => `<th>${nfmt(t.min)}+ units</th>`)
              .join('')}</tr><tr>${p.tiers
              .slice(0, 4)
              .map((t) => `<td>${inr(t.price)}</td>`)
              .join('')}</tr></table>`
          : '') +
        `<div class="stock ${p.atp > 0 ? 'ok' : 'mto'}">${esc(stockText(p))}</div>` +
        `</div></div>`;
    }
    html += `${footer(pi + 2)}</div>`;
  }

  for (let sp = 0; sp < summaryPages; sp++) {
    const chunk = products.slice(sp * SUMMARY_ROWS, sp * SUMMARY_ROWS + SUMMARY_ROWS);
    html +=
      `<div class="pg">${header()}<h2>At a glance${summaryPages > 1 ? ` (${sp + 1}/${summaryPages})` : ''}</h2>` +
      `<table class="sum"><tr><th>SKU</th><th>Product</th><th class="num">MOQ</th><th>Lead time</th><th class="num">From (ex-GST)</th><th class="num">Stock</th></tr>` +
      chunk
        .map(
          (p) =>
            `<tr><td>${esc(p.sku)}</td><td>${esc(clip(p.name, 70))}</td>` +
            `<td class="num">${p.moq}</td><td>${esc(p.leadTime || '—')}</td>` +
            `<td class="num"><b>${fromPrice(p) ? inr(fromPrice(p)) : '—'}</b></td>` +
            `<td class="num ${p.atp > 0 ? 'ok' : 'mto'}">${p.atp > 0 ? nfmt(p.atp) : 'MTO'}</td></tr>`,
        )
        .join('') +
      `</table>${footer(2 + productPages + sp)}</div>`;
  }

  return `${html}</body></html>`;
}
