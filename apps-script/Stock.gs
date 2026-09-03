/**
 * Merchforce Ops — stock screens (phase 5).
 *
 * Four views over data the system already keeps, plus one new tab:
 *   Reorder      products at or below their reorder point, with a suggested
 *                quantity that already nets off what is on order or in production
 *   Fulfilment   open orders from PO Received onward, aged against the stage SLA,
 *                with any line the stock cannot cover flagged
 *   Production   supply orders of kind 'make' (goods produced in house)
 *   Purchases    supply orders of kind 'buy' (goods bought from vendors)
 *
 * A product's supply_mode decides which plan a reorder lands in. Both kinds
 * live in the one Supply tab; the kind column tells them apart. Receiving a
 * supply order is the only thing here that touches on_hand, and it goes
 * through StockLog like every other movement.
 *
 * Every number is measured from StockLog and the order book. Nothing is
 * forecast (see Analytics.gs for why).
 */

var SUPPLY_KINDS = ['make', 'buy'];
var SUPPLY_STATUSES = ['Planned', 'Open', 'Done', 'Cancelled'];
var COVER_DAYS = 30;          // buffer on top of lead time when suggesting a quantity
var CONSUMPTION_DAYS = 90;    // trailing window the rate is measured over

function stockReady_() {
  var ss = db_();
  var sh = ss.getSheetByName('Products');
  if (!ss.getSheetByName('Supply') || !sh) return false;
  var hdr = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  return hdr.indexOf('supply_mode') >= 0;
}
var STOCK_NOT_READY_ = 'The Supply tab and the product supply columns do not exist in the sheet yet. ' +
  'Open the Apps Script editor and run setupRun once — it appends them and leaves existing data alone.';

/* ---------------- shared measurements ---------------- */

/** Units per day that actually left the building, per SKU, over the window. */
function consumption_(days, nowMs) {
  var cutoff = nowMs - days * DAY_MS;
  var out = {}, last = {};
  readRows_('StockLog').forEach(function (e) {
    var delta = toNum_(e.delta);
    if (delta >= 0) return;
    if (!/^(PO received|dispatch)/i.test(String(e.reason))) return;
    var k = skuKey_(e.sku);
    var ts = new Date(e.ts).getTime();
    if (!last[k] || ts > last[k]) last[k] = ts;
    if (ts < cutoff) return;
    out[k] = (out[k] || 0) + Math.abs(delta);
  });
  return { units: out, last: last, days: days };
}

function leadDays_(r) { return toNum_(String(r.lead_time || '').replace(/[^0-9.]/g, '')) || 14; }
function supplyMode_(r) { return String(r.supply_mode || '').toLowerCase() === 'make' ? 'make' : 'buy'; }
/** Lot a suggestion is rounded up to: production batch for made goods, vendor MOQ for bought ones. */
function lotOf_(r) {
  var lot = supplyMode_(r) === 'make' ? toNum_(r.batch_qty) : toNum_(r.vendor_moq);
  return lot || toNum_(r.moq) || 1;
}

/** Open supply quantity per SKU (Planned + Open, less anything already received). */
function inbound_() {
  var out = {};
  readRows_('Supply').forEach(function (s) {
    if (['Planned', 'Open'].indexOf(String(s.status)) < 0) return;
    var left = toNum_(s.qty) - toNum_(s.received_qty);
    if (left <= 0) return;
    var k = skuKey_(s.sku);
    out[k] = (out[k] || 0) + left;
  });
  return out;
}

/* ---------------- reorder ---------------- */

function reorderRows_(products, cons, inbound) {
  var rows = [];
  products.forEach(function (r) {
    var k = skuKey_(r.sku);
    var atp = atp_(r);
    var rop = toNum_(r.reorder_point);
    var due = atp <= 0 || (rop > 0 && atp <= rop);
    if (!due) return;
    var rate = (cons.units[k] || 0) / cons.days;
    var lead = leadDays_(r);
    var lot = lotOf_(r);
    var target = Math.ceil(rate * (lead + COVER_DAYS)) + toNum_(r.safety_stock);
    var gap = target - atp - (inbound[k] || 0);
    var suggest = 0;
    if (gap > 0) suggest = Math.max(lot, Math.ceil(gap / lot) * lot);
    else if (!(inbound[k] || 0) && rop > 0) suggest = lot;   // below the point with nothing coming: at least one lot
    rows.push({
      sku: String(r.sku), name: r.name, brand: r.brand_id || '',
      mode: supplyMode_(r), vendor: r.vendor || '',
      atp: atp, on_hand: toNum_(r.on_hand), reserved: toNum_(r.reserved),
      reorder_point: rop, safety_stock: toNum_(r.safety_stock),
      rate_per_day: Math.round(rate * 100) / 100,
      days_cover: rate > 0 ? Math.floor(atp / rate) : null,
      lead_days: lead, lot: lot,
      inbound: inbound[k] || 0,
      target: target, suggest_qty: suggest,
      covered: gap <= 0 && (inbound[k] || 0) > 0,
      last_out: cons.last[k] ? Utilities.formatDate(new Date(cons.last[k]), 'Asia/Kolkata', 'd MMM yyyy') : ''
    });
  });
  rows.sort(function (a, b) {
    var ac = a.days_cover === null ? 9999 : a.days_cover;
    var bc = b.days_cover === null ? 9999 : b.days_cover;
    return (a.atp <= 0 ? 0 : 1) - (b.atp <= 0 ? 0 : 1) || ac - bc || a.atp - b.atp;
  });
  return rows;
}

/* ---------------- fulfilment queue ---------------- */

var FULFIL_STAGES = ['PO Received', 'In Production', 'Dispatched'];

function fulfilmentRows_(requests, products, nowMs) {
  var prod = {};
  products.forEach(function (r) { prod[skuKey_(r.sku)] = r; });
  var rows = [];
  requests.forEach(function (r, i) {
    if (FULFIL_STAGES.indexOf(String(r.status)) < 0) return;
    var hit = { rowNum: i + 2, rec: r };
    var o = orderPayload_(hit, false);
    var dates = o.status_dates || {};
    var since = dates[o.status] ? new Date(dates[o.status]).getTime() : new Date(o.created).getTime();
    var age = Math.floor((nowMs - since) / DAY_MS);
    var sla = STAGE_SLA[o.status] || 7;
    var units = 0, short = [];
    o.lines.forEach(function (l) {
      units += l.qty;
      var pr = prod[skuKey_(l.sku)];
      // Stock was deducted at PO Received, so a negative on hand means this
      // order was promised units the shelf did not have.
      if (!pr) short.push(l.sku + ' (not in catalogue)');
      else if (toNum_(pr.on_hand) < 0) short.push(l.sku + ' short by ' + Math.abs(toNum_(pr.on_hand)));
    });
    var shipped = 0;
    o.shipments.forEach(function (s) { shipped += s.qty; });
    rows.push({
      order: o, id: o.id, company: o.company, status: o.status,
      po_number: o.po_number, age_days: age, sla_days: sla, overdue: age > sla,
      lines: o.lines.length, units: units, shipped: shipped, short: short
    });
  });
  // Most overdue first, then oldest in stage.
  rows.sort(function (a, b) { return (b.age_days - b.sla_days) - (a.age_days - a.sla_days); });
  return rows;
}

/* ---------------- supply orders ---------------- */

function ymd_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, 'Asia/Kolkata', 'yyyy-MM-dd');
  var m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  var d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd');
}

function supplyOut_(s) {
  return {
    id: s.so_id, kind: s.kind, sku: String(s.sku), name: s.name, qty: toNum_(s.qty),
    vendor: s.vendor || '', status: s.status, expected: ymd_(s.expected),
    ref: s.ref || '', note: s.note || '', created_by: s.created_by || '',
    created: String(s.created || ''), updated: String(s.updated || ''),
    received_qty: toNum_(s.received_qty), received: String(s.received || '')
  };
}

function supplyRows_() {
  return readRows_('Supply').map(supplyOut_).reverse();
}

function fnAdminStock_(p) {
  if (!stockReady_()) return err_(STOCK_NOT_READY_);
  var nowMs = now_().getTime();
  var products = readRows_('Products');
  var requests = readRows_('Requests');
  var cons = consumption_(CONSUMPTION_DAYS, nowMs);
  var inbound = inbound_();
  var reorder = reorderRows_(products, cons, inbound);
  var queue = fulfilmentRows_(requests, products, nowMs);
  var supply = supplyRows_();
  var s = getSettings_();
  var noRop = 0, unsetMode = 0;
  products.forEach(function (r) {
    if (!toNum_(r.reorder_point)) noRop++;
    if (!String(r.supply_mode || '').trim()) unsetMode++;
  });
  return ok_({
    generated_at: Utilities.formatDate(now_(), 'Asia/Kolkata', 'd MMM yyyy, h:mm a'),
    measured_over_days: CONSUMPTION_DAYS, cover_days: COVER_DAYS,
    reorder: reorder,
    queue: queue,
    supply: supply,
    products: products.map(function (r) {
      return { sku: String(r.sku), name: r.name, mode: supplyMode_(r), vendor: r.vendor || '',
               lot: lotOf_(r), atp: atp_(r), on_hand: toNum_(r.on_hand), lead_days: leadDays_(r),
               reorder_point: toNum_(r.reorder_point), safety_stock: toNum_(r.safety_stock),
               vendor_moq: toNum_(r.vendor_moq), batch_qty: toNum_(r.batch_qty), moq: toNum_(r.moq) };
    }),
    counts: {
      out_of_stock: reorder.filter(function (r) { return r.atp <= 0; }).length,
      reorder_due: reorder.length,
      covered: reorder.filter(function (r) { return r.covered; }).length,
      queue: queue.length,
      overdue: queue.filter(function (r) { return r.overdue; }).length,
      short_orders: queue.filter(function (r) { return r.short.length; }).length,
      make_open: supply.filter(function (r) { return r.kind === 'make' && ['Planned', 'Open'].indexOf(r.status) >= 0; }).length,
      buy_open: supply.filter(function (r) { return r.kind === 'buy' && ['Planned', 'Open'].indexOf(r.status) >= 0; }).length,
      no_reorder_point: noRop, supply_mode_unset: unsetMode
    },
    reorder_alert: s.reorder_alert || 'off',
    notify_email: s.notify_email || ''
  });
}

/** Per-SKU supply parameters, edited from the reorder screen. Nothing else on the product changes. */
function fnAdminSupplyFields_(p) {
  if (!stockReady_()) return err_(STOCK_NOT_READY_);
  var sku = skuKey_(p.sku);
  if (!sku) return err_('sku required');
  var rowNum = findRow_('Products', function (r) { return skuKey_(r.sku) === sku; });
  if (rowNum < 0) return err_('Product not found: ' + sku);
  var sh = sheet_('Products');
  var cols = SHEETS.Products;
  var fields = {
    supply_mode: SUPPLY_KINDS.indexOf(String(p.supply_mode || '').toLowerCase()) >= 0 ? String(p.supply_mode).toLowerCase() : 'buy',
    vendor: String(p.vendor || '').trim(),
    vendor_moq: toNum_(p.vendor_moq) || '',
    batch_qty: toNum_(p.batch_qty) || '',
    reorder_point: toNum_(p.reorder_point),
    safety_stock: toNum_(p.safety_stock),
    lead_time: String(p.lead_time || '').trim(),
    updated: now_()
  };
  Object.keys(fields).forEach(function (k) {
    var i = cols.indexOf(k);
    if (i >= 0) sh.getRange(rowNum, i + 1).setValue(fields[k]);
  });
  CacheService.getScriptCache().remove('catalog_v1');
  audit_(p.actor || 'admin', 'supply_fields', sku, fields.supply_mode + (fields.vendor ? ' · ' + fields.vendor : ''));
  return ok_({ sku: sku });
}

function fnAdminSupplySave_(p) {
  if (!stockReady_()) return err_(STOCK_NOT_READY_);
  var d = p.supply || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var rowNum = d.id ? findRow_('Supply', function (r) { return String(r.so_id) === String(d.id); }) : -1;
    if (d.id && rowNum < 0) return err_('Supply order not found: ' + d.id);
    var rec = rowNum > 0 ? readRows_('Supply')[rowNum - 2] : null;

    if (!rec) {
      var sku = skuKey_(d.sku);
      var pr = findRow_('Products', function (r) { return skuKey_(r.sku) === sku; });
      if (pr < 0) return err_('Product not found: ' + sku);
      var prod = readRows_('Products')[pr - 2];
      var kind = SUPPLY_KINDS.indexOf(String(d.kind || '').toLowerCase()) >= 0 ? String(d.kind).toLowerCase() : supplyMode_(prod);
      rec = {
        so_id: nextId_('Supply', 'so_id', 'SO'), kind: kind, sku: String(prod.sku), name: prod.name,
        qty: 0, vendor: d.vendor !== undefined ? String(d.vendor || '') : String(prod.vendor || ''),
        status: 'Planned', expected: '', ref: '', note: '',
        created_by: p.actor || 'admin', created: now_(), updated: now_(),
        received_qty: 0, received: ''
      };
    }
    if (d.qty !== undefined) {
      var q = toNum_(d.qty);
      if (q <= 0) return err_('Quantity must be above zero');
      if (q < toNum_(rec.received_qty)) return err_('Quantity cannot be below what has already been received (' + rec.received_qty + ')');
      rec.qty = q;
    }
    if (!toNum_(rec.qty)) return err_('Quantity required');
    if (d.vendor !== undefined) rec.vendor = String(d.vendor || '').trim();
    if (d.expected !== undefined) rec.expected = String(d.expected || '').trim();
    if (d.ref !== undefined) rec.ref = String(d.ref || '').trim();
    if (d.note !== undefined) rec.note = String(d.note || '').trim();
    if (d.status !== undefined) {
      var st = String(d.status);
      if (SUPPLY_STATUSES.indexOf(st) < 0) return err_('Unknown status: ' + st);
      if (st === 'Done' && toNum_(rec.received_qty) <= 0) return err_('Receive the goods first; Done is set when the quantity arrives');
      if (rec.status === 'Done' && st !== 'Done') return err_('A completed supply order cannot be reopened');
      rec.status = st;
    }
    rec.updated = now_();
    if (rowNum > 0) writeRecord_('Supply', rowNum, rec); else appendRecord_('Supply', rec);
    audit_(p.actor || 'admin', 'supply_save', rec.so_id, rec.kind + ' ' + rec.sku + ' × ' + rec.qty + ' · ' + rec.status);
    return ok_({ supply: supplyOut_(rec) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Goods arrived (bought) or a run finished (made). Adds to on hand through
 * StockLog. Partial receipts stay Open; the order closes when the full
 * quantity is in, or when {close:true} says the remainder will not come.
 */
function fnAdminSupplyReceive_(p) {
  if (!stockReady_()) return err_(STOCK_NOT_READY_);
  var qty = toNum_(p.qty);
  if (qty <= 0) return err_('Quantity must be above zero');
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var rowNum = findRow_('Supply', function (r) { return String(r.so_id) === String(p.id); });
    if (rowNum < 0) return err_('Supply order not found');
    var rec = readRows_('Supply')[rowNum - 2];
    if (['Planned', 'Open'].indexOf(String(rec.status)) < 0) return err_('This supply order is ' + rec.status);
    var pr = findRow_('Products', function (r) { return skuKey_(r.sku) === skuKey_(rec.sku); });
    if (pr < 0) return err_('Product not found: ' + rec.sku);

    var sh = sheet_('Products');
    var iOnHand = SHEETS.Products.indexOf('on_hand') + 1;
    sh.getRange(pr, iOnHand).setValue(toNum_(sh.getRange(pr, iOnHand).getValue()) + qty);
    var reason = (rec.kind === 'make' ? 'production done ' : 'supply received ') + rec.so_id;
    appendRecord_('StockLog', { ts: now_(), sku: rec.sku, delta: qty, reason: reason, actor: p.actor || 'admin' });

    rec.received_qty = toNum_(rec.received_qty) + qty;
    rec.received = now_();
    rec.status = (rec.received_qty >= toNum_(rec.qty) || p.close) ? 'Done' : 'Open';
    rec.updated = now_();
    writeRecord_('Supply', rowNum, rec);
    CacheService.getScriptCache().remove('catalog_v1');
    audit_(p.actor || 'admin', 'supply_receive', rec.so_id, rec.sku + ' +' + qty + ' → ' + rec.status);
    writeBackStock_([String(rec.sku)], p.actor);
    return ok_({ supply: supplyOut_(rec) });
  } finally {
    lock.releaseLock();
  }
}

function fnAdminSupplyDelete_(p) {
  if (!stockReady_()) return err_(STOCK_NOT_READY_);
  var rowNum = findRow_('Supply', function (r) { return String(r.so_id) === String(p.id); });
  if (rowNum < 0) return err_('Supply order not found');
  var rec = readRows_('Supply')[rowNum - 2];
  if (toNum_(rec.received_qty) > 0) return err_('Stock has been received against this order; cancel it instead of deleting');
  sheet_('Supply').deleteRow(rowNum);
  audit_(p.actor || 'admin', 'supply_delete', p.id, rec.sku + ' × ' + rec.qty);
  return ok_({});
}

/* ---------------- reorder alerts ---------------- */

function reorderDigestText_() {
  var nowMs = now_().getTime();
  var products = readRows_('Products');
  var rows = reorderRows_(products, consumption_(CONSUMPTION_DAYS, nowMs), inbound_());
  if (!rows.length) return null;
  var lines = rows.map(function (r) {
    return r.sku + '  ' + r.name + '\n    ATP ' + r.atp + (r.reorder_point ? ' (point ' + r.reorder_point + ')' : ' (out of stock)') +
      (r.days_cover !== null ? ' · ' + r.days_cover + ' days cover' : ' · no recent dispatches') +
      (r.inbound ? ' · ' + r.inbound + ' on order' : '') +
      (r.covered ? ' · covered by inbound' : ' · suggest ' + r.suggest_qty + ' (' + (r.mode === 'make' ? 'produce' : 'buy') + ')');
  });
  return rows.length + ' product' + (rows.length === 1 ? '' : 's') + ' at or below the reorder point as of ' +
    Utilities.formatDate(now_(), 'Asia/Kolkata', 'd MMM yyyy, h:mm a') + '.\n\n' + lines.join('\n\n') +
    '\n\nOpen the Stock tab in the console to plan a run or a purchase.';
}

function sendReorderDigest_(actor) {
  var to = getSettings_().notify_email;
  if (!to) return { sent: false, reason: 'notify_email is not set in Settings' };
  var text = reorderDigestText_();
  if (!text) return { sent: false, reason: 'Nothing at or below the reorder point' };
  var r = sendMail_(to, '[' + APP_NAME + '] Reorder due', text);
  audit_(actor || 'system', 'reorder_digest', '', to);
  return { sent: true, to: to, via: r && r.via ? r.via : 'backend' };
}

function fnAdminStockAlert_(p) {
  if (!stockReady_()) return err_(STOCK_NOT_READY_);
  return ok_(sendReorderDigest_(p.actor));
}

/** Daily trigger target. */
function reorderDigest() { sendReorderDigest_('system'); }

function fnAdminStockSchedule_(p) {
  var mode = p.mode === 'daily' ? 'daily' : 'off';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'reorderDigest') ScriptApp.deleteTrigger(t);
  });
  if (mode === 'daily') ScriptApp.newTrigger('reorderDigest').timeBased().everyDays(1).atHour(8).create();
  saveSettings_({ reorder_alert: mode });
  audit_(p.actor || 'admin', 'reorder_schedule', '', mode);
  return ok_({ mode: mode });
}
