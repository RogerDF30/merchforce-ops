import PptxGenJS from 'pptxgenjs';
import {
  deckTheme, factsText, fromPrice, stockText, type DeckProduct,
} from './deck.js';

/**
 * The 16:9 deck. Same slide plan as the Apps Script version -- cover, product
 * slides at one or two per slide, then at-a-glance tables of 14 rows -- but
 * built with pptxgenjs instead of hand-written OOXML.
 *
 * Images are passed by URL. They live on the bucket's public prefix, which is
 * what makes that prefix public in the first place.
 */

const W = 13.333;
const H = 7.5;

const inr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;
const nfmt = (n: number): string => n.toLocaleString('en-IN');
const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s;

export async function deckPptx(
  deck: { name: string; company: string },
  products: DeckProduct[],
  s: Record<string, string>,
): Promise<Buffer> {
  const T = deckTheme(s);
  const compact = T.layout === 'compact';
  const per = compact ? 2 : 1;
  const today = new Date().toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
  const coName = s.co_name || s.site_name || 'Merchforce';
  const footNote = `Prices in INR, exclusive of GST  ·  Stock as at ${today}`;

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'MF16x9', width: W, height: H });
  pptx.layout = 'MF16x9';
  pptx.author = coName;
  pptx.title = deck.name;

  const chrome = (slide: PptxGenJS.Slide): void => {
    slide.addText(coName, {
      x: 0.5, y: 0.28, w: 6, h: 0.3, fontSize: 9, bold: true,
      color: T.muted, charSpacing: 1, fontFace: 'Arial',
    });
    slide.addText(deck.name, {
      x: W - 6.5, y: 0.28, w: 6, h: 0.3, fontSize: 9, bold: true,
      color: T.muted, align: 'right', charSpacing: 1, fontFace: 'Arial',
    });
    slide.addShape('line', {
      x: 0.5, y: 0.62, w: W - 1, h: 0, line: { color: T.line, width: 0.5 },
    });
    slide.addText(footNote, {
      x: 0.5, y: H - 0.55, w: 8, h: 0.3, fontSize: 8, color: T.muted, fontFace: 'Arial',
    });
  };

  // ---- cover
  const cover = pptx.addSlide();
  if (s.co_logo_url) {
    cover.addImage({ path: s.co_logo_url, x: 0.9, y: 0.8, h: 0.7, w: 2.2, sizing: { type: 'contain', w: 2.2, h: 0.7 } });
  }
  cover.addShape('rect', { x: 0.9, y: 2.5, w: 0.9, h: 0.09, fill: { color: T.accent } });
  cover.addText(`${coName} · PRODUCT DECK`, {
    x: 0.9, y: 2.7, w: 10, h: 0.3, fontSize: 10, bold: true,
    color: T.accent, charSpacing: 1.4, fontFace: 'Arial',
  });
  cover.addText(deck.name, {
    x: 0.9, y: 3.05, w: 11.5, h: 1.3, fontSize: 40, bold: true, color: T.ink, fontFace: 'Arial',
  });
  cover.addText(
    `${deck.company ? `Prepared for ${deck.company} · ` : ''}${today} · ${products.length} product${products.length === 1 ? '' : 's'}`,
    { x: 0.9, y: 4.35, w: 11.5, h: 0.4, fontSize: 14, color: T.muted, fontFace: 'Arial' },
  );
  cover.addText(
    [coName, s.co_address, s.co_gstin ? `GSTIN ${s.co_gstin}` : '', s.co_phone, s.co_email]
      .filter(Boolean)
      .join(' · ')
      .replace(/\n/g, ' '),
    { x: 0.9, y: H - 1.25, w: 11.5, h: 0.6, fontSize: 9, color: T.muted, fontFace: 'Arial' },
  );

  // ---- product slides
  for (let i = 0; i < products.length; i += per) {
    const slide = pptx.addSlide();
    chrome(slide);
    const group = products.slice(i, i + per);

    group.forEach((p, gi) => {
      // Two per slide sit side by side; one per slide gets the full width.
      const x = compact ? 0.5 + gi * (W / 2 - 0.25) : 0.9;
      const colW = compact ? W / 2 - 0.85 : W - 1.8;
      const plate = compact ? 2.3 : 3.6;
      const y = 1.0;

      slide.addShape('roundRect', {
        x, y, w: plate, h: plate,
        fill: { color: T.plate }, line: { color: T.plate, width: 0 }, rectRadius: 0.08,
      });
      if (p.image) {
        slide.addImage({
          path: p.image,
          x: x + 0.2, y: y + 0.2, w: plate - 0.4, h: plate - 0.4,
          sizing: { type: 'contain', w: plate - 0.4, h: plate - 0.4 },
        });
      }

      const tx = x + plate + 0.35;
      const tw = colW - plate - 0.35;
      let ty = y;

      const eyebrow = [p.brand, p.category].filter(Boolean).join(' · ').toUpperCase();
      if (eyebrow) {
        slide.addText(eyebrow, {
          x: tx, y: ty, w: tw, h: 0.25, fontSize: 8, bold: true,
          color: T.accent, charSpacing: 1.2, fontFace: 'Arial',
        });
        ty += 0.28;
      }
      slide.addText(clip(p.name, 60), {
        x: tx, y: ty, w: tw, h: 0.45, fontSize: compact ? 16 : 22,
        bold: true, color: T.ink, fontFace: 'Arial',
      });
      ty += compact ? 0.5 : 0.62;
      slide.addText(`${p.sku}${p.hsn ? ` · HSN ${p.hsn}` : ''}`, {
        x: tx, y: ty, w: tw, h: 0.25, fontSize: 9, color: T.muted, fontFace: 'Arial',
      });
      ty += 0.34;

      if (p.specs.length) {
        slide.addText(
          p.specs.slice(0, compact ? 4 : 7).map((t) => ({
            text: clip(t, compact ? 70 : 120),
            options: { bullet: true, fontSize: compact ? 9 : 11, color: T.ink, fontFace: 'Arial' },
          })),
          { x: tx, y: ty, w: tw, h: compact ? 0.9 : 1.6 },
        );
        ty += compact ? 1.0 : 1.7;
      }

      slide.addText(factsText(p).replace(/ {3}/g, ' '), {
        x: tx, y: ty, w: tw, h: 0.28, fontSize: compact ? 9 : 11,
        bold: true, color: T.ink, fontFace: 'Arial',
      });
      ty += 0.36;

      if (p.tiers.length) {
        const tiers = p.tiers.slice(0, 4);
        slide.addTable(
          [
            tiers.map((t) => ({
              text: `${nfmt(t.min)}+ units`,
              options: { fontSize: 8, color: T.muted, fontFace: 'Arial' },
            })),
            tiers.map((t) => ({
              text: inr(t.price),
              options: { fontSize: compact ? 12 : 14, bold: true, color: T.ink, fontFace: 'Arial' },
            })),
          ],
          { x: tx, y: ty, w: tw, colW: tiers.map(() => tw / tiers.length), border: { type: 'none' } },
        );
        ty += 0.75;
      }

      slide.addText(stockText(p), {
        x: tx, y: ty, w: tw, h: 0.28, fontSize: compact ? 9 : 11,
        bold: true, color: p.atp > 0 ? T.ok : T.warn, fontFace: 'Arial',
      });
    });
  }

  // ---- at a glance
  const SUMMARY_ROWS = 14;
  for (let sp = 0; sp * SUMMARY_ROWS < products.length; sp++) {
    const chunk = products.slice(sp * SUMMARY_ROWS, (sp + 1) * SUMMARY_ROWS);
    const slide = pptx.addSlide();
    chrome(slide);
    const total = Math.ceil(products.length / SUMMARY_ROWS);
    slide.addText(`At a glance${total > 1 ? ` (${sp + 1}/${total})` : ''}`, {
      x: 0.5, y: 0.8, w: 8, h: 0.4, fontSize: 18, bold: true, color: T.ink, fontFace: 'Arial',
    });

    const head = ['SKU', 'Product', 'MOQ', 'Lead time', 'From (ex-GST)', 'Stock'];
    const rows = [
      head.map((h) => ({
        text: h,
        options: {
          fontSize: 8, bold: true, color: T.muted, fontFace: 'Arial',
          border: { type: 'solid' as const, pt: 1, color: T.ink },
        },
      })),
      ...chunk.map((p) => [
        { text: p.sku, options: { fontSize: 9, color: T.ink, fontFace: 'Arial' } },
        { text: clip(p.name, 52), options: { fontSize: 9, color: T.ink, fontFace: 'Arial' } },
        { text: String(p.moq), options: { fontSize: 9, align: 'right' as const, color: T.ink, fontFace: 'Arial' } },
        { text: p.leadTime || '—', options: { fontSize: 9, color: T.ink, fontFace: 'Arial' } },
        {
          text: fromPrice(p) ? inr(fromPrice(p)) : '—',
          options: { fontSize: 9, bold: true, align: 'right' as const, color: T.ink, fontFace: 'Arial' },
        },
        {
          text: p.atp > 0 ? nfmt(p.atp) : 'MTO',
          options: { fontSize: 9, align: 'right' as const, color: p.atp > 0 ? T.ok : T.warn, fontFace: 'Arial' },
        },
      ]),
    ];

    slide.addTable(rows, {
      x: 0.5, y: 1.35, w: W - 1,
      colW: [1.9, 4.6, 0.9, 1.6, 1.9, 1.4],
      border: { type: 'solid', pt: 0.5, color: T.line },
      autoPage: false,
    });
  }

  // nodebuffer is the Node output; the browser-oriented modes would give a
  // base64 string or a blob.
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}
