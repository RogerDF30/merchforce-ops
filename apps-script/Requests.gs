/** Merchforce — buyer requests (leads) and their lifecycle */

/**
 * Buyer submits a request cart.
 * Body: {company, contact, email, phone, gstin, notes, lines:[{sku, qty}]}
 * Validates MOQ + visibility, snapshots the tier price, creates the lead.
 * Stock is NOT reserved here (industry pattern: reserve at Confirmed).
 */
function fnRequestSubmit_(p) {
  if (!p.company || !p.contact || !p.email) return err_('Company, contact and email are required');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(p.email))) return err_('Invalid email');
  var lines = (p.lines || []).slice(0, 40);
  if (!lines.length) return err_('Cart is empty');

  var products = {};
  readRows_('Products').forEach(function (r) { products[skuKey_(r.sku)] = r; });
  var tiers = {};
  readRows_('PriceTiers').forEach(function (t) {
    (tiers[skuKey_(t.sku)] = tiers[skuKey_(t.sku)] || []).push({ min: toNum_(t.min_qty), price: toNum_(t.unit_price) });
  });

  var cleaned = [];
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var pr = products[skuKey_(ln.sku)];
    if (!pr || !isTrue_(pr.visible)) return err_('Unknown product: ' + ln.sku);
    var qty = Math.floor(toNum_(ln.qty));
    if (qty < toNum_(pr.moq)) return err_(pr.name + ': minimum order is ' + pr.moq);
    var price = 0;
    (tiers[skuKey_(ln.sku)] || []).sort(function (a, b) { return a.min - b.min; })
      .forEach(function (t) { if (qty >= t.min) price = t.price; });
    cleaned.push({ sku: String(ln.sku), name: pr.name, qty: qty, price: price,
                   total: qty * price, gst: toNum_(pr.gst_rate),
                   hsn: String(pr.hsn || '') });
  }

  var id = nextRequestId_();
  var total = cleaned.reduce(function (s, l) { return s + l.total; }, 0);
  appendRecord_('Requests', {
    request_id: id, created: now_(), status: 'New',
    company: String(p.company).slice(0, 200), contact: String(p.contact).slice(0, 100),
    email: String(p.email).slice(0, 150), phone: String(p.phone || '').slice(0, 30),
    gstin: String(p.gstin || '').slice(0, 20), notes: String(p.notes || '').slice(0, 1000),
    user_email: String(p.user_email || ''), total_est: total,
    status_dates: JSON.stringify({ New: String(now_()) }), admin_notes: '', updated: now_(),
    token: randomToken_(28), stock_state: ''
  });
  cleaned.forEach(function (l, idx) {
    appendRecord_('RequestLines', {
      request_id: id, line: idx + 1, sku: l.sku, name: l.name,
      qty: l.qty, unit_price: l.price, line_total: l.total,
      list_price: l.price, gst: l.gst, hsn: l.hsn || ''
    });
  });
  fnTrack_({ events: cleaned.map(function (l) { return { sku: l.sku, type: 'request' }; }) });
  audit_(p.email, 'request_new', id, cleaned.length + ' lines, est ' + total);
  notifyNewRequest_(id, p, cleaned, total);
  return ok_({ request_id: id, total_est: total });
}

function notifyNewRequest_(id, p, lines, total) {
  var to = getSettings_().notify_email;
  if (!to) return;
  try {
    var body = 'New request ' + id + ' from ' + p.company + ' (' + p.contact + ', ' + p.email +
      (p.phone ? ', ' + p.phone : '') + ')\n\n' +
      lines.map(function (l) { return l.sku + '  ' + l.name + '  x' + l.qty + '  @' + l.price; }).join('\n') +
      '\n\nEstimated total: ' + total + '\nNotes: ' + (p.notes || '-') +
      '\n\nOpen the admin console to review.';
    sendMail_(to, '[' + (getSettings_().site_name || APP_NAME) + '] New request ' + id + ' — ' + p.company,
              body, { replyTo: p.email });
  } catch (e) { audit_('system', 'mail_fail', id, String(e)); }
}

/** Admin: list requests with lines. */
function fnAdminRequests_(p) {
  var lines = {};
  readRows_('RequestLines').forEach(function (l) {
    (lines[l.request_id] = lines[l.request_id] || []).push({
      sku: l.sku, name: l.name, qty: toNum_(l.qty),
      unit_price: toNum_(l.unit_price), line_total: toNum_(l.line_total)
    });
  });
  var out = readRows_('Requests').map(function (r) {
    return {
      id: r.request_id, created: String(r.created), status: r.status,
      company: r.company, contact: r.contact, email: r.email, phone: r.phone,
      gstin: r.gstin, notes: r.notes, admin_notes: r.admin_notes,
      total_est: toNum_(r.total_est), status_dates: safeJson_(r.status_dates),
      lines: lines[r.request_id] || []
    };
  }).reverse();
  return ok_({ requests: out });
}

function safeJson_(v) { try { return JSON.parse(v || '{}'); } catch (e) { return {}; } }

/**
 * Admin: move a request through the lifecycle (or save admin notes).
 * Concurrency guard: Confirmed re-checks ATP atomically inside LockService.
 * Confirmed reserves stock; leaving Confirmed (Closed keeps it consumed via
 * on_hand decrement at Dispatched; Rejected/Expired from Confirmed releases).
 */
function fnAdminRequestUpdate_(p) {
  var rowNum = findRow_('Requests', function (r) { return r.request_id === p.id; });
  if (rowNum < 0) return err_('Request not found');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var req = readRows_('Requests')[rowNum - 2];

    if (p.admin_notes !== undefined) {
      req.admin_notes = String(p.admin_notes).slice(0, 2000);
    }

    if (p.status && p.status !== req.status) {
      var valid = STATUSES.concat(TERMINAL);
      if (valid.indexOf(p.status) < 0) return err_('Bad status');
      var from = req.status, to = p.status;

      var lines = readRows_('RequestLines').filter(function (l) { return l.request_id === p.id; });

      if (to === 'Confirmed') {
        // atomic ATP re-check — first confirmed wins
        var products = {};
        readRows_('Products').forEach(function (r) { products[skuKey_(r.sku)] = r; });
        var short = [];
        lines.forEach(function (l) {
          var pr = products[skuKey_(l.sku)];
          if (!pr || atp_(pr) < toNum_(l.qty)) {
            short.push(l.sku + ' (need ' + l.qty + ', ATP ' + (pr ? atp_(pr) : 0) + ')');
          }
        });
        if (short.length) {
          return err_('Insufficient stock — offer partial/backorder or requote: ' + short.join(', '));
        }
        adjustStock_(lines, 'reserved', +1, 'confirm ' + p.id, p.actor);
      }
      if (from === 'Confirmed' && (to === 'Rejected' || to === 'Expired')) {
        adjustStock_(lines, 'reserved', -1, 'release ' + p.id, p.actor);
      }
      if (to === 'Dispatched' && from === 'Confirmed') {
        // consume: reserved → shipped (on_hand down, reserved down)
        adjustStock_(lines, 'dispatch', 0, 'dispatch ' + p.id, p.actor);
      }

      req.status = to;
      var dates = safeJson_(req.status_dates);
      dates[to] = String(now_());
      req.status_dates = JSON.stringify(dates);
      audit_(p.actor || 'admin', 'request_status', p.id, from + ' → ' + to);
    }

    req.updated = now_();
    writeRecord_('Requests', rowNum, req);
    CacheService.getScriptCache().remove('catalog_v1');
    return ok_({ id: p.id, status: req.status });
  } finally {
    lock.releaseLock();
  }
}

/** dir +1: reserve qty. dir -1: release. mode 'dispatch': on_hand -= qty, reserved -= qty. */
function adjustStock_(lines, mode, dir, reason, actor) {
  var sh = sheet_('Products');
  var cols = SHEETS.Products;
  var iOnHand = cols.indexOf('on_hand') + 1;
  var iReserved = cols.indexOf('reserved') + 1;
  lines.forEach(function (l) {
    var rowNum = findRow_('Products', function (r) { return skuKey_(r.sku) === skuKey_(l.sku); });
    if (rowNum < 0) return;
    var qty = toNum_(l.qty);
    if (mode === 'dispatch') {
      sh.getRange(rowNum, iOnHand).setValue(toNum_(sh.getRange(rowNum, iOnHand).getValue()) - qty);
      sh.getRange(rowNum, iReserved).setValue(Math.max(0, toNum_(sh.getRange(rowNum, iReserved).getValue()) - qty));
      appendRecord_('StockLog', { ts: now_(), sku: l.sku, delta: -qty, reason: reason, actor: actor || 'admin' });
    } else {
      var cur = toNum_(sh.getRange(rowNum, iReserved).getValue());
      sh.getRange(rowNum, iReserved).setValue(Math.max(0, cur + dir * qty));
      appendRecord_('StockLog', { ts: now_(), sku: l.sku, delta: 0, reason: reason + ' (reserved ' + (dir > 0 ? '+' : '-') + qty + ')', actor: actor || 'admin' });
    }
  });
}
