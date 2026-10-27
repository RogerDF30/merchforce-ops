/**
 * Merchforce — customer returns.
 *
 * Staff log a return against an order that has shipped. It moves
 *   Requested → Approved → Received → Closed   (or Rejected before receipt)
 * Receiving is the inspection: every returned unit is either restocked (back
 * on hand, StockLog 'returned …', which also takes it out of consumption) or
 * scrapped (recorded, no stock). Closing needs a resolution: credit note,
 * refund, replacement (a linked zero-value order that deducts stock and ships
 * like any other) or none.
 */

var RETURN_STATUSES = ['Requested', 'Approved', 'Received', 'Closed', 'Rejected'];
var RETURN_REASONS = ['Refused at delivery', 'Damaged', 'Wrong item', 'Quality issue', 'Excess / not needed', 'Other'];
var RESOLUTIONS = ['Credit note', 'Refund', 'Replacement', 'None'];
var RETURNABLE = ['Dispatched', 'Delivered', 'Closed'];

function returnsReady_() {
  var ss = db_();
  return !!(ss.getSheetByName('Returns') && ss.getSheetByName('ReturnLines'));
}
var RETURNS_NOT_READY_ = 'The Returns tabs do not exist in the sheet yet. ' +
  'Open the Apps Script editor and run setupRun once — it adds them and leaves existing data alone.';

function returnOut_(r, lines) {
  return {
    id: r.rma_id, request_id: String(r.request_id), company: r.company, status: r.status,
    reason: r.reason, note: r.note, carrier: r.carrier, tracking: r.tracking,
    resolution: r.resolution, amount: toNum_(r.amount), ref: r.ref, doc_url: r.doc_url,
    replacement_id: r.replacement_id, status_dates: safeJson_(r.status_dates),
    created_by: r.created_by, created: String(r.created),
    lines: lines.filter(function (l) { return String(l.rma_id) === String(r.rma_id); }).map(function (l) {
      return { sku: String(l.sku), name: l.name, qty: toNum_(l.qty),
               restocked: toNum_(l.restocked), scrapped: toNum_(l.scrapped) };
    })
  };
}

function returnRow_(id) {
  var rowNum = findRow_('Returns', function (r) { return String(r.rma_id) === String(id); });
  if (rowNum < 0) return null;
  return { rowNum: rowNum, rec: readRows_('Returns')[rowNum - 2] };
}

function setReturnStatus_(hit, status, actor) {
  var dates = safeJson_(hit.rec.status_dates);
  dates[status] = String(now_());
  hit.rec.status_dates = JSON.stringify(dates);
  hit.rec.status = status;
  hit.rec.updated = now_();
  writeRecord_('Returns', hit.rowNum, hit.rec);
  audit_(actor || 'admin', 'return_status', hit.rec.rma_id, status);
}

/** Admin: every return, newest first, optionally for one order. */
function fnAdminReturns_(p) {
  if (!returnsReady_()) return err_(RETURNS_NOT_READY_);
  var lines = readRows_('ReturnLines');
  var out = readRows_('Returns')
    .filter(function (r) { return !p.request_id || String(r.request_id) === String(p.request_id); })
    .map(function (r) { return returnOut_(r, lines); }).reverse();
  return ok_({ returns: out, reasons: RETURN_REASONS, resolutions: RESOLUTIONS });
}

/** Admin: log a return. Lines are capped at what was ordered less what is already coming back. */
function fnAdminReturnCreate_(p) {
  if (!returnsReady_()) return err_(RETURNS_NOT_READY_);
  var hit = requestRow_(p.request_id);
  if (!hit) return err_('Order not found');
  if (RETURNABLE.indexOf(hit.rec.status) < 0) return err_('Only an order that has shipped can take a return (this one is ' + hit.rec.status + ')');
  if (RETURN_REASONS.indexOf(p.reason) < 0) return err_('Choose a reason');

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ordered = {}, names = {};
    linesOf_(hit.rec.request_id).forEach(function (l) {
      var k = skuKey_(l.sku);
      ordered[k] = (ordered[k] || 0) + toNum_(l.qty); names[k] = l.name;
    });
    var live = {};
    readRows_('Returns').forEach(function (r) {
      if (String(r.request_id) === String(hit.rec.request_id) && r.status !== 'Rejected') live[r.rma_id] = 1;
    });
    var already = {};
    readRows_('ReturnLines').forEach(function (l) {
      if (live[l.rma_id]) already[skuKey_(l.sku)] = (already[skuKey_(l.sku)] || 0) + toNum_(l.qty);
    });

    var clean = [];
    for (var i = 0; i < (p.lines || []).length; i++) {
      var l = p.lines[i], k = skuKey_(l.sku), q = Math.floor(toNum_(l.qty));
      if (!q) continue;
      if (!ordered[k]) return err_(l.sku + ' is not on this order');
      var left = ordered[k] - (already[k] || 0);
      if (q < 0 || q > left) return err_(names[k] + ': at most ' + left + ' can be returned');
      clean.push({ sku: String(l.sku), name: names[k], qty: q });
    }
    if (!clean.length) return err_('Enter a quantity for at least one line');

    var id = nextId_('Returns', 'rma_id', 'RMA');
    appendRecord_('Returns', {
      rma_id: id, request_id: hit.rec.request_id, company: hit.rec.company, status: 'Requested',
      reason: p.reason, note: String(p.note || '').slice(0, 1000), carrier: '', tracking: '',
      resolution: '', amount: '', ref: '', doc_url: '', replacement_id: '',
      status_dates: JSON.stringify({ Requested: String(now_()) }),
      created_by: p.actor || 'admin', created: now_(), updated: now_()
    });
    clean.forEach(function (l, idx) {
      appendRecord_('ReturnLines', { rma_id: id, line: idx + 1, sku: l.sku, name: l.name, qty: l.qty, restocked: 0, scrapped: 0 });
    });
    audit_(p.actor || 'admin', 'return_new', id, hit.rec.request_id + ' · ' + p.reason);
    return ok_({ id: id });
  } finally { lock.releaseLock(); }
}

/** Admin: approve or reject, and keep carrier / tracking / note current. */
function fnAdminReturnUpdate_(p) {
  if (!returnsReady_()) return err_(RETURNS_NOT_READY_);
  var hit = returnRow_(p.id);
  if (!hit) return err_('Return not found');
  var st = hit.rec.status;
  if (st === 'Closed' || st === 'Rejected') return err_('This return is ' + st);

  ['carrier', 'tracking', 'note'].forEach(function (f) {
    if (p[f] !== undefined) hit.rec[f] = String(p[f]).slice(0, f === 'note' ? 1000 : 120);
  });
  if (p.status && p.status !== st) {
    var allowed = { Requested: ['Approved', 'Rejected'], Approved: ['Rejected'], Received: [] }[st] || [];
    if (allowed.indexOf(p.status) < 0) return err_('A ' + st + ' return cannot move to ' + p.status);
    setReturnStatus_(hit, p.status, p.actor);
  } else {
    hit.rec.updated = now_();
    writeRecord_('Returns', hit.rowNum, hit.rec);
  }
  return ok_({ id: p.id, status: hit.rec.status });
}

/** Admin: goods are back. Every unit is restocked or scrapped; restocked units go back on hand. */
function fnAdminReturnReceive_(p) {
  if (!returnsReady_()) return err_(RETURNS_NOT_READY_);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var hit = returnRow_(p.id);
    if (!hit) return err_('Return not found');
    if (hit.rec.status !== 'Approved') return err_('Approve the return before receiving it (it is ' + hit.rec.status + ')');

    var got = {};
    (p.lines || []).forEach(function (l) { got[skuKey_(l.sku)] = l; });
    var sh = sheet_('ReturnLines');
    var rows = readRows_('ReturnLines'), restock = [];
    for (var i = 0; i < rows.length; i++) {
      var l = rows[i];
      if (String(l.rma_id) !== String(p.id)) continue;
      var g = got[skuKey_(l.sku)] || {};
      var rs = Math.floor(toNum_(g.restocked)), sc = Math.floor(toNum_(g.scrapped));
      if (rs < 0 || sc < 0 || rs + sc !== toNum_(l.qty)) {
        return err_(l.name + ': restocked + scrapped must equal the ' + l.qty + ' returned');
      }
      l.restocked = rs; l.scrapped = sc;
      writeRecord_('ReturnLines', i + 2, l);
      if (rs) restock.push({ sku: l.sku, qty: rs });
    }
    if (restock.length) adjustStock_(restock, 'return', 0, 'returned ' + p.id + ' (' + hit.rec.request_id + ')', p.actor);
    hit = returnRow_(p.id);
    setReturnStatus_(hit, 'Received', p.actor);
    CacheService.getScriptCache().remove('catalog_v1');
    return ok_({ id: p.id, status: 'Received', restocked: restock });
  } finally { lock.releaseLock(); }
}

/** Admin: settle with the customer and close. */
function fnAdminReturnClose_(p) {
  if (!returnsReady_()) return err_(RETURNS_NOT_READY_);
  var hit = returnRow_(p.id);
  if (!hit) return err_('Return not found');
  if (hit.rec.status !== 'Received') return err_('Receive the goods before closing (it is ' + hit.rec.status + ')');
  var res = String(p.resolution || '');
  if (RESOLUTIONS.indexOf(res) < 0) return err_('Choose how the return is resolved');
  if ((res === 'Credit note' || res === 'Refund') && !(toNum_(p.amount) > 0)) return err_('Enter the ' + res.toLowerCase() + ' amount');

  var order = requestRow_(hit.rec.request_id);
  if (res === 'Replacement') {
    var made = replacementOrder_(hit, order, p.actor);
    if (made.error) return err_(made.error);
    hit.rec.replacement_id = made.id;
  }
  if (p.data && p.filename) {
    var bytes = Utilities.base64Decode(String(p.data).replace(/^data:[^;]+;base64,/, ''));
    if (bytes.length > 10 * 1024 * 1024) return err_('File over 10MB');
    var file = requestFolder_(order).createFile(Utilities.newBlob(bytes, p.mime || 'application/pdf', p.filename));
    hit.rec.doc_url = publicFileUrl_(file);
  }
  hit.rec.resolution = res;
  hit.rec.amount = res === 'Credit note' || res === 'Refund' ? toNum_(p.amount) : '';
  hit.rec.ref = String(p.ref || '').slice(0, 80);
  setReturnStatus_(hit, 'Closed', p.actor);
  return ok_({ id: p.id, status: 'Closed', replacement_id: hit.rec.replacement_id || '' });
}

/**
 * A replacement is a new order for the returned quantities at zero value,
 * started at PO Received so it deducts stock and ships through the normal
 * shipment flow. Refused (and nothing written) if the stock is not there.
 */
function replacementOrder_(ret, order, actor) {
  var lines = readRows_('ReturnLines').filter(function (l) { return String(l.rma_id) === String(ret.rec.rma_id); });
  var products = {};
  readRows_('Products').forEach(function (r) { products[skuKey_(r.sku)] = r; });
  var short = [];
  lines.forEach(function (l) {
    var pr = products[skuKey_(l.sku)];
    if (!pr || atp_(pr) < toNum_(l.qty)) short.push(l.sku + ' (need ' + l.qty + ', available ' + (pr ? atp_(pr) : 0) + ')');
  });
  if (short.length) return { error: 'Not enough stock for a replacement: ' + short.join(', ') };

  var o = order.rec, prices = {};
  linesOf_(o.request_id).forEach(function (l) { prices[skuKey_(l.sku)] = l; });
  var id = nextRequestId_();
  appendRecord_('Requests', {
    request_id: id, created: now_(), status: 'New',
    company: o.company, contact: o.contact, email: o.email, phone: o.phone, gstin: o.gstin,
    notes: 'Replacement for ' + ret.rec.rma_id + ' (order ' + o.request_id + ')',
    user_email: '', total_est: 0,
    status_dates: JSON.stringify({ New: String(now_()) }), admin_notes: '', updated: now_(),
    token: randomToken_(28), stock_state: '',
    ship_address: o.ship_address, place_of_supply: o.place_of_supply,
    company_id: o.company_id, raised_by: actor || 'admin',
    assigned_to: o.assigned_to, assigned_name: o.assigned_name
  });
  lines.forEach(function (l, idx) {
    var src = prices[skuKey_(l.sku)] || {};
    appendRecord_('RequestLines', {
      request_id: id, line: idx + 1, sku: l.sku, name: l.name, qty: l.qty,
      unit_price: 0, line_total: 0, list_price: toNum_(src.unit_price), gst: toNum_(src.gst), hsn: src.hsn || ''
    });
  });
  clearChildCache_();
  var e = setStatus_(requestRow_(id), 'PO Received', actor || 'admin', 'replacement for ' + ret.rec.rma_id);
  if (e) return { error: e };
  audit_(actor || 'admin', 'return_replacement', ret.rec.rma_id, id);
  return { id: id };
}
