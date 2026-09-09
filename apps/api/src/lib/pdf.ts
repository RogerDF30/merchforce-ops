import { chromium, type Browser } from 'playwright-core';

/**
 * HTML to PDF.
 *
 * Apps Script got this free from Google (`blob.getAs('application/pdf')`). On
 * Node it needs a renderer, and a browser is the honest choice: the proforma
 * template is real HTML and CSS with a styled table, and the deck builder will
 * want the same. A pure-JS PDF library would mean rewriting both layouts
 * imperatively.
 *
 * The browser is launched once and reused. Each render gets its own context,
 * so one document cannot see another's state.
 */
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ args: ['--no-sandbox'] });
    // A crashed browser must not be cached forever as a rejected promise.
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  const b = await browserPromise;
  if (!b.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }
  return b;
}

export interface PdfOptions {
  format?: 'A4' | 'Letter';
  landscape?: boolean;
  margin?: { top: string; right: string; bottom: string; left: string };
}

export async function htmlToPdf(
  html: string,
  opts: PdfOptions = {},
): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // `domcontentloaded` rather than `networkidle`: a logo hosted somewhere
    // slow should delay the invoice, not hang the request forever.
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    // Give remote images a bounded chance to arrive.
    await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {});
    return await page.pdf({
      format: opts.format ?? 'A4',
      landscape: opts.landscape ?? false,
      printBackground: true,
      margin: opts.margin ?? {
        top: '0mm', right: '0mm', bottom: '0mm', left: '0mm',
      },
    });
  } finally {
    await context.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  await b?.close();
}
