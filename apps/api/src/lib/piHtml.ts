import { stateCodeOf } from './gst.js';

/**
 * The proforma invoice, ported from piHtml_ in apps-script/Orders.gs.
 *
 * The GST treatment is the part that matters: when the supplier's state and the
 * place of supply match it is an intra-state sale and the tax splits into CGST
 * and SGST at half each; otherwise it is inter-state and shows as a single
 * IGST line. Getting that wrong makes the document useless for input credit.
 */

export interface PiLine {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
  gst: number;
  hsn: string;
}

export interface PiExtras {
  piNumber: string;
  validTill: string;
  freight: number;
  discount: number;
  notes: string;
  placeOfSupply: string;
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const money = (n: number): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Join only the parts that are present. Written out because the Sheets template
 * concatenated a separator whenever the SECOND value existed, so an empty phone
 * with an email set printed a stray leading "·" on the invoice.
 */
const join = (sep: string, ...parts: unknown[]): string =>
  parts
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .map(esc)
    .join(sep);

const dmy = (d: Date): string =>
  d.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });

export function piHtml(
  req: {
    ref: string;
    company: string;
    contact: string;
    email: string;
    phone: string;
    gstin: string;
    billingAddress: string;
    shipAddress: string;
  },
  lines: PiLine[],
  extras: PiExtras,
  s: Record<string, string>,
): string {
  const supplierCode = String(s.co_state_code || stateCodeOf(s.co_gstin) || '');
  const buyerCode = String(extras.placeOfSupply || stateCodeOf(req.gstin) || '');
  const intra = !!supplierCode && !!buyerCode && supplierCode === buyerCode;

  let sub = 0;
  let taxTotal = 0;
  const rows = lines
    .map((l, i) => {
      const amt = l.qty * l.unitPrice;
      const tax = (amt * l.gst) / 100;
      sub += amt;
      taxTotal += tax;
      return (
        `<tr><td class="c">${i + 1}</td>` +
        `<td>${esc(l.name)}<div class="sku">${esc(l.sku)}</div></td>` +
        `<td class="c">${esc(l.hsn)}</td>` +
        `<td class="r">${l.qty}</td>` +
        `<td class="r">${money(l.unitPrice)}</td>` +
        `<td class="r">${money(amt)}</td>` +
        `<td class="c">${l.gst}%</td>` +
        `<td class="r">${money(tax)}</td></tr>`
      );
    })
    .join('');

  const grand = sub + taxTotal + extras.freight - extras.discount;
  const half = taxTotal / 2;

  const taxRows = intra
    ? `<tr><td>CGST</td><td class="r">${money(half)}</td></tr>` +
      `<tr><td>SGST</td><td class="r">${money(half)}</td></tr>`
    : `<tr><td>IGST</td><td class="r">${money(taxTotal)}</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#16192b;margin:26px}
h1{font-size:19px;margin:0 0 2px;letter-spacing:-.3px}
.muted{color:#6b7280}.r{text-align:right}.c{text-align:center}
.head{display:flex;justify-content:space-between;border-bottom:2px solid #16192b;padding-bottom:10px;margin-bottom:14px}
.box{border:1px solid #d6dae6;border-radius:6px;padding:10px;width:48%}
.two{display:flex;justify-content:space-between;gap:12px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;margin-top:6px}
th{background:#f2f4fa;border:1px solid #d6dae6;padding:6px;font-size:10px;text-transform:uppercase;letter-spacing:.4px}
td{border:1px solid #d6dae6;padding:6px;vertical-align:top}
.sku{color:#8890a5;font-size:9.5px}
.tot td{border:none;padding:3px 6px}.tot .r{width:120px}
.grand{font-weight:bold;font-size:13px;border-top:1px solid #16192b}
.foot{margin-top:18px;display:flex;justify-content:space-between;gap:16px}
.terms{white-space:pre-wrap;font-size:10px;color:#4a5065;width:60%}
.sign{text-align:center;font-size:10px}
</style></head><body>
<div class="head"><div>
${s.co_logo_url ? `<img src="${esc(s.co_logo_url)}" style="height:34px;margin-bottom:6px">` : ''}
<h1>${esc(s.co_name || s.site_name || 'Merchforce')}</h1>
<div class="muted">${esc(s.co_address).replace(/\n/g, '<br>')}</div>
<div class="muted">${join(
    ' &nbsp;·&nbsp; ',
    s.co_gstin ? `GSTIN: ${s.co_gstin}` : '',
    s.co_pan ? `PAN: ${s.co_pan}` : '',
  )}</div>
<div class="muted">${join(' · ', s.co_phone, s.co_email)}</div>
</div><div class="r">
<h1>PROFORMA INVOICE</h1>
<div><b>${esc(extras.piNumber)}</b></div>
<div class="muted">Date: ${dmy(new Date())}</div>
<div class="muted">Valid till: ${esc(extras.validTill)}</div>
<div class="muted">Ref: ${esc(req.ref)}</div>
</div></div>

<div class="two">
<div class="box"><b>Bill to</b><br>
<b>${esc(req.company)}</b><br>
<span class="muted">${esc(req.billingAddress).replace(/\n/g, '<br>')}</span><br>
${req.gstin ? `<span class="muted">GSTIN: ${esc(req.gstin)}</span><br>` : ''}
<span class="muted">${join(' · ', req.contact, req.phone)}</span><br>
<span class="muted">${esc(req.email)}</span>
</div>
<div class="box"><b>Ship to</b><br>
<span class="muted">${esc(req.shipAddress || req.billingAddress).replace(/\n/g, '<br>')}</span><br>
<span class="muted">Place of supply: ${esc(buyerCode)}</span>
</div>
</div>

<table><thead><tr>
<th>#</th><th>Item</th><th>HSN</th><th>Qty</th><th>Rate</th><th>Amount</th><th>GST</th><th>Tax</th>
</tr></thead><tbody>${rows}</tbody></table>

<div class="foot">
<div class="terms">${extras.notes ? `${esc(extras.notes)}\n\n` : ''}${esc(s.co_terms)}${
    s.co_bank ? `\n\nBank details\n${esc(s.co_bank)}` : ''
  }</div>
<table class="tot" style="width:270px">
<tr><td>Subtotal</td><td class="r">${money(sub)}</td></tr>
${taxRows}
${extras.freight ? `<tr><td>Freight</td><td class="r">${money(extras.freight)}</td></tr>` : ''}
${extras.discount ? `<tr><td>Discount</td><td class="r">-${money(extras.discount)}</td></tr>` : ''}
<tr class="grand"><td>Total (INR)</td><td class="r">${money(grand)}</td></tr>
</table>
</div>

<div class="foot"><div></div><div class="sign">
${s.co_sign_url ? `<img src="${esc(s.co_sign_url)}" style="height:46px"><br>` : '<br><br><br>'}
For <b>${esc(s.co_name || s.site_name || 'Merchforce')}</b><br>
<span class="muted">Authorised signatory</span>
</div></div>
</body></html>`;
}

export function piTotal(
  lines: PiLine[],
  freight: number,
  discount: number,
): number {
  const total = lines.reduce((a, l) => {
    const amt = l.qty * l.unitPrice;
    return a + amt + (amt * l.gst) / 100;
  }, 0);
  return Math.round((total + freight - discount) * 100) / 100;
}
