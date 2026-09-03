/**
 * Merchforce — order lifecycle: acceptance, proforma invoice, purchase order,
 * shipments, and the client's own view of an order.
 *
 * Stock discipline (the whole point of the flow):
 *   PI Accepted  → RESERVE  (ATP drops; the goods are held for this buyer)
 *   PO Received  → DEDUCT   (on hand actually reduces; the sale is real)
 *   Rejected / Declined / Expired / Cancelled → release anything reserved
 *     that was never deducted.
 * request.stock_state ('', 'reserved', 'deducted') is the source of truth, so
 * a status corrected by hand can never double-reserve or double-deduct.
 *
 * Every request gets its own Drive folder (Merchforce/Requests/<request id>)
 * holding its PI and PO, and its own unguessable token: the client acts on the
 * order straight from the notification email, without an account.
 */

var GST_STATES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman & Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory'
};

function stateCodeOf_(gstin) {
  var m = String(gstin || '').trim().match(/^(\d{2})/);
  return m ? m[1] : '';
}

/* ---------------------------------------------------------------- helpers */

function requestRow_(id) {
  var rowNum = findRow_('Requests', function (r) { return String(r.request_id) === String(id); });
  if (rowNum < 0) return null;
  return { rowNum: rowNum, rec: readRows_('Requests')[rowNum - 2] };
}

function linesOf_(id) {
  return readRows_('RequestLines').filter(function (l) { return String(l.request_id) === String(id); });
}

/**
 * Product master lookup for tax fields, built once per execution.
 * Order lines snapshot HSN/GST when the request is raised, but orders created
 * before a SKU had an HSN (or before the field existed) fall back to the master
 * so the quotation builder is never left with a blank HSN to type by hand.
 */
var PROD_TAX_ = null;
function prodTax_(sku) {
  if (!PROD_TAX_) {
    PROD_TAX_ = {};
    readRows_('Products').forEach(function (r) {
      PROD_TAX_[skuKey_(r.sku)] = { hsn: String(r.hsn || ''), gst: toNum_(r.gst_rate) };
    });
  }
  return PROD_TAX_[skuKey_(sku)] || { hsn: '', gst: 0 };
}

function ensureToken_(hit) {
  if (hit.rec.token) return hit.rec.token;
  hit.rec.token = randomToken_(28);
  writeRecord_('Requests', hit.rowNum, hit.rec);
  return hit.rec.token;
}

/** Drive folder for one request, created on first use. */
function requestFolder_(hit) {
  if (hit.rec.folder_id) {
    try { return DriveApp.getFolderById(hit.rec.folder_id); } catch (e) { /* recreate below */ }
  }
  var root = DriveApp.getFolderById(props_().getProperty('FOLDER_ID'));
  var requests = ensureChild_(root, 'Requests');
  var folder = ensureChild_(requests, String(hit.rec.request_id));
  hit.rec.folder_id = folder.getId();
  writeRecord_('Requests', hit.rowNum, hit.rec);
  return folder;
}

function publicFileUrl_(file) {
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/file/d/' + file.getId() + '/view';
}

function siteUrl_() {
  return String(getSettings_().site_url || props_().getProperty('SITE_URL') || '').replace(/\/$/, '');
}

function orderLink_(token) {
  var base = siteUrl_();
  return base ? base + '/order.html?t=' + token : '';
}

/* ------------------------------------------------------------ stock moves */

/** Apply a stock transition for a request. Returns null, or an error string. */
function moveStock_(hit, target, actor) {
  var cur = String(hit.rec.stock_state || '');
  if (cur === target) return null;
  var lines = linesOf_(hit.rec.request_id);
  var id = hit.rec.request_id;

  if (target === 'reserved' && cur === '') {
    var products = {};
    readRows_('Products').forEach(function (r) { products[skuKey_(r.sku)] = r; });
    var short = [];
    lines.forEach(function (l) {
      var pr = products[skuKey_(l.sku)];
      if (!pr || atp_(pr) < toNum_(l.qty)) {
        short.push(String(l.sku) + ' (need ' + l.qty + ', available ' + (pr ? atp_(pr) : 0) + ')');
      }
    });
    if (short.length) return 'Not enough stock to hold for this order: ' + short.join(', ');
    adjustStock_(lines, 'reserved', +1, 'PI accepted ' + id, actor);
  } else if (target === 'deducted' && cur === 'reserved') {
    adjustStock_(lines, 'dispatch', 0, 'PO received ' + id, actor);   // on hand −, reserved −
  } else if (target === 'deducted' && cur === '') {
    adjustStock_(lines, 'reserved', +1, 'PO received ' + id, actor);
    adjustStock_(lines, 'dispatch', 0, 'PO received ' + id, actor);
  } else if (target === '' && cur === 'reserved') {
    adjustStock_(lines, 'reserved', -1, 'released ' + id, actor);
  } else if (target === '' && cur === 'deducted') {
    return 'Stock was already deducted for this order — adjust it in the catalog instead';
  }
  hit.rec.stock_state = target;
  return null;
}

/** The stock state each status implies. */
function stockStateFor_(status) {
  if (['PI Accepted'].indexOf(status) >= 0) return 'reserved';
  if (['PO Received', 'In Production', 'Dispatched', 'Delivered', 'Closed'].indexOf(status) >= 0) return 'deducted';
  if (TERMINAL.indexOf(status) >= 0) return '';
  return null;   // New / Accepted / PI Sent — leave whatever is there
}

/** Single place every status change goes through. */
function setStatus_(hit, status, actor, note) {
  var from = hit.rec.status;
  if (from === status) return null;
  if (STATUSES.concat(TERMINAL).indexOf(status) < 0) return 'Unknown status';

  var want = stockStateFor_(status);
  if (want !== null) {
    var err = moveStock_(hit, want, actor);
    if (err) return err;
  }
  hit.rec.status = status;
  var dates = safeJson_(hit.rec.status_dates);
  dates[status] = String(now_());
  hit.rec.status_dates = JSON.stringify(dates);
  hit.rec.updated = now_();
  writeRecord_('Requests', hit.rowNum, hit.rec);
  CacheService.getScriptCache().remove('catalog_v1');
  audit_(actor || 'admin', 'order_status', hit.rec.request_id, from + ' → ' + status + (note ? ' · ' + note : ''));
  return null;
}

/* ------------------------------------------------------- proforma invoice */

function nextPiNumber_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var seq = toNum_(props_().getProperty('PI_SEQ')) + 1;
    props_().setProperty('PI_SEQ', String(seq));
    var s = getSettings_();
    return (s.pi_prefix || 'PI') + '-' + Utilities.formatDate(now_(), 'Asia/Kolkata', 'yyyy') +
           '-' + ('0000' + seq).slice(-4);
  } finally { lock.releaseLock(); }
}

function money_(n) {
  return Number(toNum_(n)).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function esc_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build the PI HTML. GST is split CGST+SGST when the buyer is in the issuer's
 * own state, IGST otherwise — the one thing that makes a PI usable in India.
 */
function piHtml_(req, lines, extras) {
  var s = getSettings_();
  var supplierCode = String(s.co_state_code || stateCodeOf_(s.co_gstin) || '');
  var buyerCode = String(extras.place_of_supply || stateCodeOf_(req.gstin) || '');
  var intra = supplierCode && buyerCode && supplierCode === buyerCode;

  var sub = 0, taxTotal = 0, rows = '';
  lines.forEach(function (l, i) {
    var qty = toNum_(l.qty), rate = toNum_(l.unit_price);
    var amt = qty * rate, gst = toNum_(l.gst);
    var tax = amt * gst / 100;
    sub += amt; taxTotal += tax;
    rows +=
      '<tr><td class="c">' + (i + 1) + '</td>' +
      '<td>' + esc_(l.name) + '<div class="sku">' + esc_(l.sku) + '</div></td>' +
      '<td class="c">' + esc_(l.hsn || '') + '</td>' +
      '<td class="r">' + qty + '</td>' +
      '<td class="r">' + money_(rate) + '</td>' +
      '<td class="r">' + money_(amt) + '</td>' +
      '<td class="c">' + gst + '%</td>' +
      '<td class="r">' + money_(tax) + '</td></tr>';
  });

  var freight = toNum_(extras.freight), discount = toNum_(extras.discount);
  var grand = sub + taxTotal + freight - discount;
  var half = taxTotal / 2;

  return '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#16192b;margin:26px}' +
    'h1{font-size:19px;margin:0 0 2px;letter-spacing:-.3px}' +
    '.muted{color:#6b7280}.r{text-align:right}.c{text-align:center}' +
    '.head{display:flex;justify-content:space-between;border-bottom:2px solid #16192b;padding-bottom:10px;margin-bottom:14px}' +
    '.box{border:1px solid #d6dae6;border-radius:6px;padding:10px;width:48%}' +
    '.two{display:flex;justify-content:space-between;gap:12px;margin-bottom:14px}' +
    'table{width:100%;border-collapse:collapse;margin-top:6px}' +
    'th{background:#f2f4fa;border:1px solid #d6dae6;padding:6px;font-size:10px;text-transform:uppercase;letter-spacing:.4px}' +
    'td{border:1px solid #d6dae6;padding:6px;vertical-align:top}' +
    '.sku{color:#8890a5;font-size:9.5px}' +
    '.tot td{border:none;padding:3px 6px}.tot .r{width:120px}' +
    '.grand{font-weight:bold;font-size:13px;border-top:1px solid #16192b}' +
    '.foot{margin-top:18px;display:flex;justify-content:space-between;gap:16px}' +
    '.terms{white-space:pre-wrap;font-size:10px;color:#4a5065;width:60%}' +
    '.sign{text-align:center;font-size:10px}' +
    '</style></head><body>' +
    '<div class="head"><div>' +
      (s.co_logo_url ? '<img src="' + esc_(s.co_logo_url) + '" style="height:34px;margin-bottom:6px">' : '') +
      '<h1>' + esc_(s.co_name || s.site_name || APP_NAME) + '</h1>' +
      '<div class="muted">' + esc_(s.co_address).replace(/\n/g, '<br>') + '</div>' +
      '<div class="muted">' + (s.co_gstin ? 'GSTIN: ' + esc_(s.co_gstin) : '') +
        (s.co_pan ? ' &nbsp;·&nbsp; PAN: ' + esc_(s.co_pan) : '') + '</div>' +
      '<div class="muted">' + esc_(s.co_phone) + (s.co_email ? ' · ' + esc_(s.co_email) : '') + '</div>' +
    '</div><div class="r">' +
      '<h1>PROFORMA INVOICE</h1>' +
      '<div><b>' + esc_(extras.pi_number) + '</b></div>' +
      '<div class="muted">Date: ' + Utilities.formatDate(now_(), 'Asia/Kolkata', 'd MMM yyyy') + '</div>' +
      '<div class="muted">Valid till: ' + esc_(extras.valid_till) + '</div>' +
      '<div class="muted">Ref: ' + esc_(req.request_id) + '</div>' +
    '</div></div>' +

    '<div class="two">' +
      '<div class="box"><b>Bill to</b><br>' + esc_(req.company) + '<br>' +
        '<span class="muted">' + esc_(req.contact) + (req.phone ? ' · ' + esc_(req.phone) : '') + '<br>' +
        esc_(req.email) + '</span>' +
        (req.gstin ? '<br>GSTIN: ' + esc_(req.gstin) : '') + '</div>' +
      '<div class="box"><b>Ship to</b><br>' +
        (req.ship_address ? esc_(req.ship_address).replace(/\n/g, '<br>') : '<span class="muted">Same as billing</span>') +
        '<br><span class="muted">Place of supply: ' + esc_(GST_STATES[buyerCode] || buyerCode || '—') + '</span></div>' +
    '</div>' +

    '<table><thead><tr><th>#</th><th>Description</th><th>HSN</th><th class="r">Qty</th>' +
      '<th class="r">Rate</th><th class="r">Amount</th><th class="c">GST</th><th class="r">Tax</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +

    '<table class="tot" style="margin-top:10px"><tbody>' +
      '<tr><td class="r muted">Subtotal</td><td class="r">' + money_(sub) + '</td></tr>' +
      (intra
        ? '<tr><td class="r muted">CGST</td><td class="r">' + money_(half) + '</td></tr>' +
          '<tr><td class="r muted">SGST</td><td class="r">' + money_(half) + '</td></tr>'
        : '<tr><td class="r muted">IGST</td><td class="r">' + money_(taxTotal) + '</td></tr>') +
      (freight ? '<tr><td class="r muted">Freight / handling</td><td class="r">' + money_(freight) + '</td></tr>' : '') +
      (discount ? '<tr><td class="r muted">Discount</td><td class="r">−' + money_(discount) + '</td></tr>' : '') +
      '<tr class="grand"><td class="r">Total (INR)</td><td class="r">' + money_(grand) + '</td></tr>' +
    '</tbody></table>' +

    '<div class="foot"><div class="terms">' +
      (s.co_bank ? '<b>Bank details</b>\n' + esc_(s.co_bank) + '\n\n' : '') +
      (s.co_terms ? '<b>Terms</b>\n' + esc_(s.co_terms) : '') +
      (extras.notes ? '\n\n<b>Notes</b>\n' + esc_(extras.notes) : '') +
      '\n\nThis is a proforma invoice, not a tax invoice. Stock is subject to prior sale until this proforma is accepted.' +
    '</div><div class="sign">' +
      (s.co_sign_url ? '<img src="' + esc_(s.co_sign_url) + '" style="height:46px"><br>' : '<br><br><br>') +
      'For ' + esc_(s.co_name || s.site_name || APP_NAME) + '<br>Authorised signatory</div></div>' +
    '</body></html>';
}

/** Admin: build the PI from negotiated lines, save the PDF, optionally send it. */
function fnAdminPiBuild_(p) {
  var hit = requestRow_(p.id);
  if (!hit) return err_('Request not found');
  var s = getSettings_();
  var incoming = p.lines || [];
  if (!incoming.length) return err_('The quotation needs at least one line');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // Rewrite the order lines at the negotiated prices — the PI governs from here.
    var existing = {};
    linesOf_(p.id).forEach(function (l) { existing[skuKey_(l.sku)] = l; });
    var clean = incoming.map(function (l, i) {
      var old = existing[skuKey_(l.sku)] || {};
      return {
        request_id: hit.rec.request_id, line: i + 1, sku: String(l.sku), name: l.name || old.name || '',
        qty: Math.max(0, Math.floor(toNum_(l.qty))),
        unit_price: toNum_(l.unit_price),
        line_total: Math.max(0, Math.floor(toNum_(l.qty))) * toNum_(l.unit_price),
        list_price: old.list_price !== undefined && old.list_price !== '' ? old.list_price : toNum_(old.unit_price),
        gst: toNum_(l.gst), hsn: l.hsn || old.hsn || prodTax_(l.sku).hsn || ''
      };
    }).filter(function (l) { return l.qty > 0; });
    if (!clean.length) return err_('Every line has zero quantity');
    replaceChildRows_('RequestLines', function (r) { return String(r.request_id) === String(p.id); }, clean);

    var days = toNum_(p.validity_days) || toNum_(s.pi_validity_days) || 15;
    var validTill = Utilities.formatDate(new Date(now_().getTime() + days * 86400000), 'Asia/Kolkata', 'd MMM yyyy');
    var piNumber = hit.rec.pi_number || nextPiNumber_();
    var extras = {
      pi_number: piNumber, valid_till: validTill, freight: toNum_(p.freight),
      discount: toNum_(p.discount), notes: p.notes || '',
      place_of_supply: p.place_of_supply || stateCodeOf_(hit.rec.gstin)
    };
    if (p.ship_address !== undefined) hit.rec.ship_address = String(p.ship_address).slice(0, 500);

    var html = piHtml_(hit.rec, clean, extras);
    var pdf = Utilities.newBlob(html, 'text/html', piNumber + '.html').getAs('application/pdf')
      .setName(piNumber + ' — ' + hit.rec.company + '.pdf');
    var file = requestFolder_(hit).createFile(pdf);

    var total = clean.reduce(function (a, l) {
      return a + l.line_total + (l.line_total * toNum_(l.gst) / 100);
    }, 0) + toNum_(p.freight) - toNum_(p.discount);

    hit.rec.pi_number = piNumber;
    hit.rec.pi_file_id = file.getId();
    hit.rec.pi_url = publicFileUrl_(file);
    hit.rec.pi_total = Math.round(total * 100) / 100;
    hit.rec.pi_valid_till = validTill;
    hit.rec.total_est = hit.rec.pi_total;
    hit.rec.place_of_supply = extras.place_of_supply;
    writeRecord_('Requests', hit.rowNum, hit.rec);
    audit_(p.actor || 'admin', 'pi_built', hit.rec.request_id, piNumber + ' · ' + hit.rec.pi_total);
  } finally {
    lock.releaseLock();
  }

  if (p.send !== false) {
    var e = setStatus_(requestRow_(p.id), 'PI Sent', p.actor || 'admin');
    if (e) return err_(e);
    notifyPiSent_(requestRow_(p.id));
  }
  var fresh = requestRow_(p.id);
  return ok_({ pi_number: fresh.rec.pi_number, pi_url: fresh.rec.pi_url,
               pi_total: fresh.rec.pi_total, status: fresh.rec.status });
}

/** Admin: attach a PI produced outside the system. */
function fnAdminPiUpload_(p) {
  var hit = requestRow_(p.id);
  if (!hit) return err_('Request not found');
  if (!p.data || !p.filename) return err_('data + filename required');
  var bytes = Utilities.base64Decode(String(p.data).replace(/^data:[^;]+;base64,/, ''));
  if (bytes.length > 10 * 1024 * 1024) return err_('File over 10MB');
  var file = requestFolder_(hit).createFile(
    Utilities.newBlob(bytes, p.mime || 'application/pdf', p.filename));
  hit.rec.pi_number = p.pi_number || hit.rec.pi_number || nextPiNumber_();
  hit.rec.pi_file_id = file.getId();
  hit.rec.pi_url = publicFileUrl_(file);
  if (p.pi_total) { hit.rec.pi_total = toNum_(p.pi_total); hit.rec.total_est = hit.rec.pi_total; }
  if (p.valid_till) hit.rec.pi_valid_till = String(p.valid_till);
  writeRecord_('Requests', hit.rowNum, hit.rec);
  audit_(p.actor || 'admin', 'pi_upload', hit.rec.request_id, hit.rec.pi_number);
  if (p.send !== false) {
    var e = setStatus_(requestRow_(p.id), 'PI Sent', p.actor || 'admin');
    if (e) return err_(e);
    notifyPiSent_(requestRow_(p.id));
  }
  return ok_({ pi_number: hit.rec.pi_number, pi_url: hit.rec.pi_url });
}

/** Admin: attach a PO that arrived by email or any other route. */
function fnAdminPoUpload_(p) {
  var hit = requestRow_(p.id);
  if (!hit) return err_('Request not found');
  if (!p.data || !p.filename) return err_('data + filename required');
  var bytes = Utilities.base64Decode(String(p.data).replace(/^data:[^;]+;base64,/, ''));
  if (bytes.length > 10 * 1024 * 1024) return err_('File over 10MB');
  var file = requestFolder_(hit).createFile(
    Utilities.newBlob(bytes, p.mime || 'application/pdf', p.filename));
  hit.rec.po_number = p.po_number || hit.rec.po_number || '';
  hit.rec.po_file_id = file.getId();
  hit.rec.po_url = publicFileUrl_(file);
  writeRecord_('Requests', hit.rowNum, hit.rec);
  var e = setStatus_(requestRow_(p.id), 'PO Received', p.actor || 'admin');
  if (e) return err_(e);
  audit_(p.actor || 'admin', 'po_upload', hit.rec.request_id, hit.rec.po_number || file.getName());
  notifyPoReceived_(requestRow_(p.id), 'admin');
  return ok_({ po_url: hit.rec.po_url, status: 'PO Received' });
}

/* ------------------------------------------------------------- shipments */

function shipmentsOf_(id) {
  return readRows_('Shipments').filter(function (r) { return String(r.request_id) === String(id); });
}

/** Admin: add or update one part-shipment. Order status follows the shipments. */
function fnAdminShipmentSave_(p) {
  var hit = requestRow_(p.id);
  if (!hit) return err_('Request not found');
  var d = p.shipment || {};
  var no = toNum_(d.shipment_no);
  var rows = shipmentsOf_(p.id);
  if (!no) no = rows.length + 1;
  var rec = {
    request_id: hit.rec.request_id, shipment_no: no,
    ship_date: d.ship_date || today_(), carrier: d.carrier || '', tracking: d.tracking || '',
    qty: toNum_(d.qty), note: String(d.note || '').slice(0, 300),
    status: d.status === 'Delivered' ? 'Delivered' : 'Dispatched',
    created: now_(), delivered_on: d.status === 'Delivered' ? (d.delivered_on || today_()) : ''
  };
  var rowNum = findRow_('Shipments', function (r) {
    return String(r.request_id) === String(p.id) && toNum_(r.shipment_no) === no;
  });
  if (rowNum > 0) {
    var old = readRows_('Shipments')[rowNum - 2];
    rec.created = old.created || now_();
    writeRecord_('Shipments', rowNum, rec);
  } else {
    appendRecord_('Shipments', rec);
  }

  var all = shipmentsOf_(p.id);
  var allDelivered = all.length && all.every(function (r) { return r.status === 'Delivered'; });
  var target = allDelivered ? 'Delivered' : 'Dispatched';
  if (hit.rec.status !== target && ACTIVE_END.indexOf(hit.rec.status) < 0) {
    var e = setStatus_(requestRow_(p.id), target, p.actor || 'admin');
    if (e) return err_(e);
  }
  audit_(p.actor || 'admin', 'shipment_save', hit.rec.request_id, 'shipment ' + no + ' · ' + rec.status);
  notifyShipment_(requestRow_(p.id), rec);
  return ok_({ shipments: shipmentsOf_(p.id), status: requestRow_(p.id).rec.status });
}

function fnAdminShipmentDelete_(p) {
  var rowNum = findRow_('Shipments', function (r) {
    return String(r.request_id) === String(p.id) && toNum_(r.shipment_no) === toNum_(p.shipment_no);
  });
  if (rowNum < 0) return err_('Shipment not found');
  sheet_('Shipments').deleteRow(rowNum);
  return ok_({ shipments: shipmentsOf_(p.id) });
}

/* ------------------------------------------------- the client's own view */

function orderPayload_(hit, forClient) {
  var r = hit.rec;
  var lines = linesOf_(r.request_id).map(function (l) {
    return { sku: String(l.sku), name: l.name, qty: toNum_(l.qty),
             unit_price: toNum_(l.unit_price), line_total: toNum_(l.line_total),
             list_price: toNum_(l.list_price) || null,
             gst: (l.gst === '' || l.gst === undefined || l.gst === null) ? prodTax_(l.sku).gst : toNum_(l.gst),
             hsn: l.hsn || prodTax_(l.sku).hsn || '' };
  });
  var out = {
    id: r.request_id, created: String(r.created), status: r.status,
    status_dates: safeJson_(r.status_dates),
    company: r.company, contact: r.contact, email: r.email, phone: r.phone, gstin: r.gstin,
    notes: r.notes, ship_address: r.ship_address || '',
    total_est: toNum_(r.total_est), lines: lines,
    pi_number: r.pi_number || '', pi_url: r.pi_url || '', pi_total: toNum_(r.pi_total) || 0,
    pi_valid_till: r.pi_valid_till || '',
    po_number: r.po_number || '', po_url: r.po_url || '',
    shipments: shipmentsOf_(r.request_id).map(function (s) {
      return { no: toNum_(s.shipment_no), date: String(s.ship_date), carrier: s.carrier,
               tracking: s.tracking, qty: toNum_(s.qty), note: s.note, status: s.status,
               delivered_on: String(s.delivered_on || '') };
    }),
    active: ACTIVE_END.indexOf(r.status) < 0 && TERMINAL.indexOf(r.status) < 0
  };
  if (!forClient) {
    out.admin_notes = r.admin_notes;
    out.stock_state = r.stock_state || '';
    out.token = r.token || '';
    out.folder_id = r.folder_id || '';
    out.place_of_supply = r.place_of_supply || '';
    out.company_id = r.company_id || '';
    out.raised_by = r.raised_by || '';
    out.assigned_to = String(r.assigned_to || '');
    out.assigned_name = r.assigned_name || '';
  }
  return out;
}

function tokenHit_(token) {
  if (!token) return null;
  var rowNum = findRow_('Requests', function (r) { return r.token && String(r.token) === String(token); });
  if (rowNum < 0) return null;
  return { rowNum: rowNum, rec: readRows_('Requests')[rowNum - 2] };
}

/** Public: the client opens their order from the link in the email. */
function fnOrderView_(p) {
  var hit = tokenHit_(p.t);
  if (!hit) return err_('This order link is not valid');
  return ok_({ order: orderPayload_(hit, true), site: { name: getSettings_().site_name } });
}

/** Public: the client accepts or declines the proforma. Acceptance holds stock. */
function fnOrderPiRespond_(p) {
  var hit = tokenHit_(p.t);
  if (!hit) return err_('This order link is not valid');
  if (hit.rec.status !== 'PI Sent') {
    return err_('This proforma is not awaiting a decision (status: ' + hit.rec.status + ')');
  }
  var accept = !!p.accept;
  var e = setStatus_(hit, accept ? 'PI Accepted' : 'Declined', 'client:' + hit.rec.email,
                     String(p.note || '').slice(0, 300));
  if (e) return err_(e);
  var fresh = requestRow_(hit.rec.request_id);
  if (p.note) {
    fresh.rec.admin_notes = String(fresh.rec.admin_notes || '') +
      '\n[client ' + today_() + '] ' + String(p.note).slice(0, 300);
    writeRecord_('Requests', fresh.rowNum, fresh.rec);
  }
  notifyPiDecision_(fresh, accept, p.note);
  return ok_({ status: fresh.rec.status });
}

/** Public: the client uploads their purchase order — this deducts the stock. */
function fnOrderPoUpload_(p) {
  var hit = tokenHit_(p.t);
  if (!hit) return err_('This order link is not valid');
  if (['PI Accepted', 'PO Received'].indexOf(hit.rec.status) < 0) {
    return err_('Accept the proforma invoice before sending a purchase order');
  }
  if (!p.data || !p.filename) return err_('Attach the purchase order file');
  var bytes = Utilities.base64Decode(String(p.data).replace(/^data:[^;]+;base64,/, ''));
  if (bytes.length > 10 * 1024 * 1024) return err_('File over 10MB');
  var file = requestFolder_(hit).createFile(
    Utilities.newBlob(bytes, p.mime || 'application/pdf', p.filename));
  hit.rec.po_number = String(p.po_number || hit.rec.po_number || '').slice(0, 60);
  hit.rec.po_file_id = file.getId();
  hit.rec.po_url = publicFileUrl_(file);
  writeRecord_('Requests', hit.rowNum, hit.rec);
  var e = setStatus_(requestRow_(hit.rec.request_id), 'PO Received', 'client:' + hit.rec.email);
  if (e) return err_(e);
  audit_('client:' + hit.rec.email, 'po_upload', hit.rec.request_id, hit.rec.po_number || file.getName());
  notifyPoReceived_(requestRow_(hit.rec.request_id), 'client');
  return ok_({ status: 'PO Received', po_url: hit.rec.po_url });
}

/** Signed-in buyers: every order raised from their email address. */

/* --------------------------------------------------------- notifications */

function supplierMail_() { return getSettings_().notify_email; }

function linesText_(id) {
  return linesOf_(id).map(function (l) {
    return '  ' + String(l.sku) + '  ' + l.name + '  ×' + l.qty + '  @ ₹' + money_(l.unit_price);
  }).join('\n');
}

function notifyPiSent_(hit) {
  var r = hit.rec, s = getSettings_();
  var link = orderLink_(ensureToken_(hit));
  sendMail_(r.email,
    '[' + (s.site_name || APP_NAME) + '] Proforma invoice ' + r.pi_number + ' for ' + r.request_id,
    'Hello ' + r.contact + ',\n\n' +
    'Your proforma invoice for ' + r.request_id + ' is ready.\n\n' +
    'PI number: ' + r.pi_number + '\n' +
    'Total: ₹' + money_(r.pi_total) + '\n' +
    (r.pi_valid_till ? 'Valid till: ' + r.pi_valid_till + '\n' : '') + '\n' +
    linesText_(r.request_id) + '\n\n' +
    (r.pi_url ? 'Download the PI: ' + r.pi_url + '\n\n' : '') +
    (link ? 'Accept it, decline it, or send us your purchase order here:\n' + link + '\n\n' : '') +
    'Stock is held for you only once the proforma is accepted.\n\n' +
    (s.co_name || s.site_name || APP_NAME),
    { replyTo: supplierMail_() });
}

function notifyPiDecision_(hit, accepted, note) {
  var r = hit.rec, s = getSettings_();
  var to = supplierMail_();
  if (!to) return;
  sendMail_(to,
    '[' + (s.site_name || APP_NAME) + '] ' + r.request_id + ' — proforma ' +
      (accepted ? 'ACCEPTED' : 'declined') + ' by ' + r.company,
    r.company + ' has ' + (accepted ? 'accepted' : 'declined') + ' proforma ' + r.pi_number + '.\n\n' +
    (accepted
      ? 'Stock is now held for this order. The purchase order is the next step — the client can upload it from their order page, or you can add it in the admin console.\n'
      : 'No stock has been held.\n') +
    (note ? '\nTheir note: ' + note + '\n' : '') +
    '\nOrder total: ₹' + money_(r.pi_total || r.total_est) + '\n',
    { replyTo: r.email });
}

function notifyPoReceived_(hit, who) {
  var r = hit.rec, s = getSettings_();
  var to = supplierMail_();
  if (to) {
    sendMail_(to,
      '[' + (s.site_name || APP_NAME) + '] ' + r.request_id + ' — purchase order received',
      (who === 'client' ? r.company + ' has uploaded their purchase order.' : 'A purchase order was added for ' + r.company + '.') + '\n\n' +
      (r.po_number ? 'PO number: ' + r.po_number + '\n' : '') +
      (r.po_url ? 'Download: ' + r.po_url + '\n' : '') +
      '\nStock has been deducted for this order. It is now in production.\n',
      { replyTo: r.email });
  }
  var link = orderLink_(ensureToken_(hit));
  sendMail_(r.email,
    '[' + (s.site_name || APP_NAME) + '] Order confirmed — ' + r.request_id,
    'Hello ' + r.contact + ',\n\nWe have your purchase order' +
    (r.po_number ? ' (' + r.po_number + ')' : '') + ' and your order is confirmed.\n\n' +
    'We will send tracking details as the goods ship.\n' +
    (link ? '\nTrack it any time: ' + link + '\n' : '') +
    '\n' + (s.co_name || s.site_name || APP_NAME),
    { replyTo: supplierMail_() });
}

function notifyShipment_(hit, sh) {
  var r = hit.rec, s = getSettings_();
  var link = orderLink_(ensureToken_(hit));
  var delivered = sh.status === 'Delivered';
  sendMail_(r.email,
    '[' + (s.site_name || APP_NAME) + '] ' + r.request_id + ' — ' +
      (delivered ? 'delivered' : 'shipment ' + sh.shipment_no + ' dispatched'),
    'Hello ' + r.contact + ',\n\n' +
    (delivered
      ? 'Shipment ' + sh.shipment_no + ' of order ' + r.request_id + ' has been delivered.\n'
      : 'Shipment ' + sh.shipment_no + ' of order ' + r.request_id + ' is on its way.\n') +
    (sh.qty ? '\nQuantity: ' + sh.qty : '') +
    (sh.carrier ? '\nCarrier: ' + sh.carrier : '') +
    (sh.tracking ? '\nTracking: ' + sh.tracking : '') +
    (sh.note ? '\nNote: ' + sh.note : '') +
    (link ? '\n\nFull order status: ' + link + '\n' : '') +
    '\n' + (s.co_name || s.site_name || APP_NAME),
    { replyTo: supplierMail_() });
}

/** Admin: accept or reject a fresh request (before any PI exists). */
function fnAdminRequestDecide_(p) {
  var hit = requestRow_(p.id);
  if (!hit) return err_('Request not found');
  var accept = !!p.accept;
  var e = setStatus_(hit, accept ? 'Accepted' : 'Rejected', p.actor || 'admin', p.note);
  if (e) return err_(e);
  var fresh = requestRow_(p.id);
  var s = getSettings_();
  var link = orderLink_(ensureToken_(fresh));
  sendMail_(fresh.rec.email,
    '[' + (s.site_name || APP_NAME) + '] ' + fresh.rec.request_id + ' — ' +
      (accept ? 'request accepted' : 'request update'),
    'Hello ' + fresh.rec.contact + ',\n\n' +
    (accept
      ? 'We have accepted your request ' + fresh.rec.request_id + ' and are preparing your proforma invoice.\n'
      : 'We are unable to take up request ' + fresh.rec.request_id + ' at this time.\n') +
    (p.note ? '\n' + p.note + '\n' : '') +
    (accept && link ? '\nFollow it here: ' + link + '\n' : '') +
    '\n' + (s.co_name || s.site_name || APP_NAME),
    { replyTo: supplierMail_() });
  return ok_({ status: fresh.rec.status });
}

/** Admin: full order list, split into active and completed. */
function fnAdminOrders_(p) {
  var out = readRows_('Requests').map(function (r, i) {
    return orderPayload_({ rowNum: i + 2, rec: r }, false);
  }).reverse();
  return ok_({
    orders: out,
    statuses: STATUSES, terminal: TERMINAL,
    site_url: siteUrl_()
  });
}
