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
  var assignee = String(p.assigned_to || '').toLowerCase().trim();
  var assigneeName = '';
  if (assignee) {
    var au = readRows_('Users').filter(function (x) { return String(x.email).toLowerCase() === assignee; })[0];
    assigneeName = au ? (au.name || au.email) : assignee;
  } else if (p.actor_email) { assignee = String(p.actor_email).toLowerCase(); assigneeName = p.actor; }
  appendRecord_('Requests', {
    request_id: id, created: now_(), status: 'New',
    company: String(p.company).slice(0, 200), contact: String(p.contact).slice(0, 100),
    email: String(p.email).slice(0, 150), phone: String(p.phone || '').slice(0, 30),
    gstin: String(p.gstin || '').slice(0, 20), notes: String(p.notes || '').slice(0, 1000),
    user_email: String(p.user_email || ''), total_est: total,
    status_dates: JSON.stringify({ New: String(now_()) }), admin_notes: '', updated: now_(),
    token: randomToken_(28), stock_state: '',
    // Staff-raised requests can carry these up front; the storefront never did.
    ship_address: String(p.ship_address || '').slice(0, 500),
    place_of_supply: String(p.place_of_supply || '').slice(0, 2),
    company_id: String(p.company_id || ''), raised_by: String(p.actor || p.raised_by || ''),
    // follow-up owner: whoever was picked, else the person raising it
    assigned_to: assignee, assigned_name: assigneeName
  });
  cleaned.forEach(function (l, idx) {
    appendRecord_('RequestLines', {
      request_id: id, line: idx + 1, sku: l.sku, name: l.name,
      qty: l.qty, unit_price: l.price, line_total: l.total,
      list_price: l.price, gst: l.gst, hsn: l.hsn || ''
    });
  });
  audit_(p.email, 'request_new', id, cleaned.length + ' lines, est ' + total);
  notifyNewRequest_(id, p, cleaned, total);
  return ok_({ request_id: id, total_est: total });
}

function notifyNewRequest_(id, p, lines, total) {
  var to = getSettings_().notify_email;
  if (!to) return;
  try {
    var body = 'New request ' + id + ' from ' + p.company + ' (' + p.contact + ', ' + p.email +
      (p.phone ? ', ' + p.phone : '') + ')' +
      (p.actor || p.raised_by ? '\nRaised in the console by ' + (p.actor || p.raised_by) : '') + '\n\n' +
      lines.map(function (l) { return l.sku + '  ' + l.name + '  x' + l.qty + '  @' + l.price; }).join('\n') +
      '\n\nEstimated total: ' + total + '\nNotes: ' + (p.notes || '-') +
      '\n\nOpen the admin console to review.';
    sendMail_(to, '[' + (getSettings_().site_name || APP_NAME) + '] New enquiry ' + id + ' — ' + p.company,
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

/** Hand an enquiry to a member of staff for follow-up; they get an email. */
function fnAdminRequestAssign_(p) {
  var rowNum = findRow_('Requests', function (r) { return r.request_id === p.id; });
  if (rowNum < 0) return err_('Enquiry not found');
  var email = String(p.assigned_to || '').toLowerCase().trim();
  var name = '';
  if (email) {
    var u = readRows_('Users').filter(function (x) { return String(x.email).toLowerCase() === email && isTrue_(x.active); })[0];
    if (!u) return err_('No active staff account with that email');
    name = u.name || u.email;
  }
  var req = readRows_('Requests')[rowNum - 2];
  var was = req.assigned_to || '';
  req.assigned_to = email; req.assigned_name = name; req.updated = now_();
  writeRecord_('Requests', rowNum, req);
  audit_(p.actor || 'admin', 'request_assign', p.id, (was || 'nobody') + ' → ' + (email || 'nobody'));
  if (email && email !== was && email !== String(p.actor_email || '').toLowerCase()) {
    try {
      sendMail_(email, '[' + bizName_() + '] ' + req.request_id + ' assigned to you',
        (p.actor || 'A colleague') + ' assigned enquiry ' + req.request_id + ' (' + req.company + ' · ' + req.status + ') to you for follow-up.\n\n' +
        'Open ' + appName_() + ' and look under My enquiries.');
    } catch (e) { /* mail is best effort */ }
  }
  return ok_({ id: p.id, assigned_to: email, assigned_name: name });
}

function safeJson_(v) { try { return JSON.parse(v || '{}'); } catch (e) { return {}; } }

/**
 * Admin: notes and manual status changes from the order dialog.
 * Status changes go through setStatus_ so the stock rules (reserve at PI
 * Accepted, deduct at PO Received, release on a terminal status) hold no
 * matter which screen moved the order.
 */
function fnAdminRequestUpdate_(p) {
  var hit = requestRow_(p.id);
  if (!hit) return err_('Request not found');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (p.admin_notes !== undefined) {
      hit.rec.admin_notes = String(p.admin_notes).slice(0, 2000);
      hit.rec.updated = now_();
      writeRecord_('Requests', hit.rowNum, hit.rec);   // notes are kept even if the status change is refused
    }
    if (p.status && p.status !== hit.rec.status) {
      var e = setStatus_(hit, p.status, p.actor || 'admin');
      if (e) return err_(e);
    }
    return ok_({ id: p.id, status: hit.rec.status });
  } finally {
    lock.releaseLock();
  }
}

/** dir +1: reserve qty. dir -1: release. mode 'dispatch': on_hand -= qty, reserved -= qty.
 *  mode 'return': on_hand += qty (a deducted order cancelled before it shipped). */
function adjustStock_(lines, mode, dir, reason, actor) {
  var sh = sheet_('Products');
  var cols = SHEETS.Products;
  var iOnHand = cols.indexOf('on_hand') + 1;
  var iReserved = cols.indexOf('reserved') + 1;
  var moved = [];
  lines.forEach(function (l) {
    var rowNum = findRow_('Products', function (r) { return skuKey_(r.sku) === skuKey_(l.sku); });
    if (rowNum < 0) return;
    var qty = toNum_(l.qty);
    if (mode === 'dispatch') {
      sh.getRange(rowNum, iOnHand).setValue(toNum_(sh.getRange(rowNum, iOnHand).getValue()) - qty);
      sh.getRange(rowNum, iReserved).setValue(Math.max(0, toNum_(sh.getRange(rowNum, iReserved).getValue()) - qty));
      appendRecord_('StockLog', { ts: now_(), sku: l.sku, delta: -qty, reason: reason, actor: actor || 'admin' });
      moved.push(String(l.sku));
    } else if (mode === 'return') {
      sh.getRange(rowNum, iOnHand).setValue(toNum_(sh.getRange(rowNum, iOnHand).getValue()) + qty);
      appendRecord_('StockLog', { ts: now_(), sku: l.sku, delta: qty, reason: reason, actor: actor || 'admin' });
      moved.push(String(l.sku));
    } else {
      var cur = toNum_(sh.getRange(rowNum, iReserved).getValue());
      sh.getRange(rowNum, iReserved).setValue(Math.max(0, cur + dir * qty));
      appendRecord_('StockLog', { ts: now_(), sku: l.sku, delta: 0, reason: reason + ' (reserved ' + (dir > 0 ? '+' : '-') + qty + ')', actor: actor || 'admin' });
      moved.push(String(l.sku));   // the sheet's Committed / Available columns follow holds too
    }
  });
  if (moved.length) writeBackStock_(moved, actor);
}
