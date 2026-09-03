/* Merchforce admin console — RSM-style */
'use strict';

var CONFIG = {
  API_URL: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? '/api' : 'https://script.google.com/macros/s/AKfycbxrQDSF3on09dWcD9Ct6Buge9k4h0kTZi13NQ_QyF7pGO3IX7ZCrrXGanyuIhYNAl-gyA/exec',
  API_TOKEN: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'mf-demo-token' : 'mf_TNzQCuxEw5TWUhwpKW3wt8HtutDJ'
};

// Bumped with every frontend cache-buster. Shown on the lock screen so a
// stale bundle is visible at a glance instead of being mistaken for a bug.
var BUILD = 'v27';

var A = {
  key: '', session: '', user: null, sessionMinutes: 30, settings: null,
  requests: [], products: [], brands: [], users: [], analytics: null,
  companies: [], contacts: [], decks: [],
  days: 90, loaded: {}, syncPreview: null
};

var STATUSES = ['New', 'Accepted', 'PI Sent', 'PI Accepted', 'PO Received', 'In Production', 'Dispatched', 'Delivered', 'Closed', 'Rejected', 'Declined', 'Expired', 'Cancelled'];

/* ---------- plumbing ---------- */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
function qty(n) { return Number(n || 0).toLocaleString('en-IN'); }
function toast(msg) {
  var t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(function () { t.hidden = true; }, 2600);
}
function api(action, body) {
  body = body || {};
  body.action = action;
  body.token = CONFIG.API_TOKEN;
  if (A.session) body.session = A.session; else body.adminKey = A.key;
  return fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow'
  }).then(function (r) {
    // A non-JSON body means Google answered with an HTML page (auth wall,
    // quota, outage) — surface that instead of a bare parse error.
    return r.text().then(function (txt) {
      try { return JSON.parse(txt); }
      catch (e) {
        throw new Error(action + ': server returned ' + r.status + ' ' +
          (r.ok ? 'with a non-JSON body' : r.statusText) +
          ' — ' + txt.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160));
      }
    });
  }, function (netErr) {
    throw new Error(action + ': could not reach the backend (' + (netErr.message || netErr) + ')');
  }).then(function (res) {
    if (!res.ok) {
      if (/session has expired|sign in again/i.test(res.error || '')) lock('Your session expired. Sign in again.');
      throw new Error(res.error || 'Request failed');
    }
    if (res.session && A.session) { A.session = res.session; persistSession(); }
    return res;
  });
}
function statusPill(s) { return '<span class="pill st-' + esc(s).replace(/ /g, '') + '">' + esc(s) + '</span>'; }
function fmtDate(d) {
  var x = new Date(d);
  return isNaN(x) ? esc(String(d)) : x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) +
    ' ' + x.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
function imgOf(sku) {
  var p = A.products.filter(function (x) { return x.sku === sku; })[0];
  return p && p.images[0] ? p.images[0] : '';
}
function brandName(id) {
  var b = A.brands.filter(function (x) { return x.id === id; })[0];
  return b ? b.name : (id || '—');
}

/* ---------- unlock ---------- */
/* ---------- sign-in, sessions, inactivity ---------- */

function persistSession() {
  try {
    if (A.session) localStorage.setItem('mf_session', JSON.stringify({ s: A.session, u: A.user }));
    else localStorage.removeItem('mf_session');
  } catch (e) {}
}
function restoreSession() {
  try {
    var raw = localStorage.getItem('mf_session');
    if (!raw) return false;
    var d = JSON.parse(raw);
    A.session = d.s || ''; A.user = d.u || null;
    return !!A.session;
  } catch (e) { return false; }
}

function enterConsole(res) {
  A.settings = res.settings;
  A.relayStatus = res.relay_status || null;
  if (res.user) A.user = res.user;
  if (res.session_minutes) A.sessionMinutes = Number(res.session_minutes) || 30;
  $('whoami').textContent = A.user ? (A.user.name + (A.user.role === 'admin' ? ' · admin' : '')) : 'master key';
  $('lock').hidden = true;
  $('console').hidden = false;
  A.loaded = {};
  A.requestsAt = 0; A.requests = [];
  document.querySelectorAll('#tabs .chip').forEach(function (x) { x.classList.toggle('on', x.dataset.t === 'enquiries'); });
  document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.id !== 'p-enquiries'; });
  loadEnquiries();
  if (!A._searchWired) { wireSearch(); A._searchWired = true; }
  armIdle();
}

function lock(msg) {
  A.session = ''; A.user = null; A.key = '';
  persistSession();
  clearTimeout(A._idle);
  $('console').hidden = true;
  $('lock').hidden = false;
  $('lockMsg').textContent = msg || 'Sign in to continue.';
  $('lPass').value = '';
  $('lockErr').textContent = '';
  showStaff();
}

function signIn() {
  var email = $('lEmail').value.trim(), pass = $('lPass').value;
  if (!email || !pass) { $('lockErr').textContent = 'Email and password, please.'; return; }
  $('loginBtn').disabled = true;
  $('lockErr').textContent = '';
  A.session = ''; A.key = '';
  fetch(CONFIG.API_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
    body: JSON.stringify({ action: 'staffLogin', token: CONFIG.API_TOKEN, email: email, password: pass })
  }).then(function (r) { return r.json(); }).then(function (res) {
    $('loginBtn').disabled = false;
    if (!res.ok) { $('lockErr').textContent = res.error || 'Sign-in failed'; return; }
    A.session = res.session; A.user = res.user;
    persistSession();
    enterConsole(res);
  }).catch(function (e) { $('loginBtn').disabled = false; $('lockErr').textContent = e.message; });
}

function unlock() {
  A.key = $('adminKey').value.trim();
  A.session = ''; A.user = null;
  if (!A.key) return;
  $('unlockBtn').disabled = true;
  $('lockErr2').textContent = '';
  api('adminUnlock').then(function (res) {
    $('unlockBtn').disabled = false;
    enterConsole(res);
  }).catch(function (e) {
    $('lockErr2').textContent = e.message;
    $('unlockBtn').disabled = false;
  });
}

function showStaff() { $('lockStaff').hidden = false; $('lockMaster').hidden = true; }
function showMaster() { $('lockStaff').hidden = true; $('lockMaster').hidden = false; }

/* Inactivity: the server refuses a stale token; this just gets the person to the
   lock screen at the same moment rather than on their next click. */
function armIdle() {
  clearTimeout(A._idle);
  A._idle = setTimeout(function () {
    lock('Signed out after ' + A.sessionMinutes + ' minutes of inactivity.');
  }, A.sessionMinutes * 60 * 1000);
}
['mousedown', 'keydown', 'touchstart', 'scroll'].forEach(function (ev) {
  document.addEventListener(ev, function () { if (!$('console').hidden) armIdle(); }, { passive: true });
});

$('unlockBtn').onclick = unlock;
$('loginBtn').onclick = signIn;
$('lPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') signIn(); });
$('adminKey').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });
$('useMaster').onclick = function (e) { e.preventDefault(); showMaster(); };
$('useStaff').onclick = function (e) { e.preventDefault(); showStaff(); };
if ($('buildTag')) $('buildTag').textContent = BUILD;

// A session survives a reload; the server decides whether it is still live.
if (restoreSession()) {
  var restore = function (again) {
    api('adminUnlock').then(enterConsole).catch(function (e) {
      if (/expired|sign in again|bad admin key/i.test(e.message)) { lock('Your sign-in has lapsed. Sign in again.'); return; }
      if (again) setTimeout(function () { restore(false); }, 1500);
      else lock('Could not reach the backend: ' + e.message);
    });
  };
  restore(true);
}
$('adminKey').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });
$('lockNow').onclick = function () { lock('Signed out.'); };

/* ---------- tabs ---------- */
var LOADERS = { enquiries: loadEnquiries, orders: loadOrders, mine: loadMine, catalog: loadCatalog, stock: loadStock, brands: loadCatalog, accounts: loadCompanies, decks: loadDecks, users: loadUsers, analytics: loadAnalytics, settings: loadSettings };
document.querySelectorAll('#tabs .chip').forEach(function (t) {
  t.onclick = function () {
    document.querySelectorAll('#tabs .chip').forEach(function (x) { x.classList.remove('on'); });
    t.classList.add('on');
    document.querySelectorAll('.panel').forEach(function (p) { p.hidden = true; });
    var name = t.dataset.t;
    $('p-' + name).hidden = false;
    if (!A.loaded[name]) LOADERS[name]();
  };
});

/* ================= ENQUIRIES · ORDERS · MY ENQUIRIES ================= */
/* One dataset (adminOrders) feeds three views. An enquiry becomes an order the
   moment a purchase order lands: PO Received and everything after it is an
   order; New through PI Accepted is an enquiry. */
var STAGES = ['New', 'Accepted', 'PI Sent', 'PI Accepted', 'PO Received', 'In Production', 'Dispatched', 'Delivered'];
var ENQUIRY_STAGES = ['New', 'Accepted', 'PI Sent', 'PI Accepted'];
var ORDER_STAGES = ['PO Received', 'In Production', 'Dispatched', 'Delivered', 'Closed'];
var STATES = [['01', 'Jammu & Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'],
  ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'], ['26', 'Dadra & Nagar Haveli and Daman & Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman & Nicobar Islands'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory']];
function stateName(code) { var s = STATES.filter(function (x) { return x[0] === String(code); })[0]; return s ? s[1] : ''; }
function stateCode(name) { var k = String(name || '').trim().toLowerCase(); var s = STATES.filter(function (x) { return x[1].toLowerCase() === k; })[0]; return s ? s[0] : ''; }
function stateOptions(selectedCode, blankLabel) {
  return '<option value="">' + esc(blankLabel || 'Choose a state') + '</option>' + STATES.map(function (s) {
    return '<option value="' + s[0] + '"' + (s[0] === String(selectedCode) ? ' selected' : '') + '>' + esc(s[1]) + '</option>';
  }).join('');
}

function isOrder(r) { return ORDER_STAGES.indexOf(r.status) >= 0 || (r.status === 'Cancelled' && !!(r.status_dates || {})['PO Received']); }
function isMine(r) {
  var me = A.user || {};
  if (me.email && r.assigned_to) return String(r.assigned_to).toLowerCase() === String(me.email).toLowerCase();
  return !!me.name && (r.assigned_name === me.name || r.raised_by === me.name);
}
function ownerCell(r) {
  return r.assigned_name ? esc(r.assigned_name) : '<span style="color:var(--ink-3)">unassigned</span>';
}

var STAFF_CACHE = null;
function staffList() {
  if (STAFF_CACHE) return Promise.resolve(STAFF_CACHE);
  return api('adminStaffList').then(function (res) { STAFF_CACHE = res.staff; return STAFF_CACHE; }).catch(function () { return []; });
}
function staffOptions(staff, selectedEmail, blankLabel) {
  return '<option value="">' + esc(blankLabel || 'Unassigned') + '</option>' + staff.map(function (u) {
    return '<option value="' + esc(u.email) + '"' + (u.email === String(selectedEmail || '').toLowerCase() ? ' selected' : '') + '>' + esc(u.name) + '</option>';
  }).join('');
}

function stat(v, l) { return '<div class="stat"><div class="stat-n">' + v + '</div><div class="stat-l">' + l + '</div></div>'; }

/* ---------- data ---------- */
function loadRequests() {
  return api('adminOrders').then(function (res) {
    A.requests = res.orders;
    A.siteUrl = res.site_url || '';
    A.requestsAt = Date.now();
    paintRequestViews();
  }).catch(function (e) {
    ['p-enquiries', 'p-orders', 'p-mine'].forEach(function (id) { if (A.loaded[id.slice(2)]) $(id).innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  });
}
function ensureRequests() {
  return A.requests && A.requestsAt ? Promise.resolve() : loadRequests();
}
function paintRequestViews() {
  if (A.loaded.enquiries) renderEnquiries();
  if (A.loaded.orders) renderOrders();
  if (A.loaded.mine) renderMine();
}
function loadEnquiries() { A.loaded.enquiries = true; $('p-enquiries').innerHTML = '<div class="spin"></div>'; ensureRequests().then(renderEnquiries); }
function loadOrders() { A.loaded.orders = true; $('p-orders').innerHTML = '<div class="spin"></div>'; ensureRequests().then(renderOrders); }
function loadMine() { A.loaded.mine = true; $('p-mine').innerHTML = '<div class="spin"></div>'; ensureRequests().then(renderMine); }

/* ---------- filter bars ---------- */
/* defs: [{key, label, options:[[value,label],...]}], state: object the values live in.
   Renders selects (and an optional text box) and calls onChange after any change. */
A.filters = A.filters || {};
function filterState(name) { return A.filters[name] = A.filters[name] || {}; }
function filterBar(name, defs, withText) {
  var st = filterState(name);
  return '<div class="fbar" id="fb-' + name + '">' +
    (withText ? '<input data-fk="q" placeholder="' + esc(withText) + '" value="' + esc(st.q || '') + '">' : '') +
    defs.map(function (d) {
      return '<select data-fk="' + d.key + '" title="' + esc(d.label) + '"><option value="">' + esc(d.label) + ': all</option>' +
        d.options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(st[d.key] || '') === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    }).join('') +
    (Object.keys(st).some(function (k) { return st[k]; }) ? '<button class="btn ghost small" data-fk="clear">Clear</button>' : '') +
    '</div>';
}
function wireFilterBar(name, onChange) {
  var st = filterState(name), bar = $('fb-' + name);
  if (!bar) return;
  bar.querySelectorAll('select[data-fk]').forEach(function (s) { s.onchange = function () { st[s.dataset.fk] = s.value; onChange(); }; });
  var q = bar.querySelector('input[data-fk="q"]');
  if (q) q.oninput = function () { st.q = q.value; onChange(true); };
  var clr = bar.querySelector('button[data-fk="clear"]');
  if (clr) clr.onclick = function () { Object.keys(st).forEach(function (k) { delete st[k]; }); onChange(); };
}
function uniq(list) { var seen = {}; return list.filter(function (v) { if (!v || seen[v]) return false; seen[v] = 1; return true; }).sort(); }

/* Enquiry / order filters shared by the three views. */
function requestFilterDefs(rows, kind) {
  var statuses = kind === 'order' ? ORDER_STAGES.concat(['Cancelled']) : ENQUIRY_STAGES.concat(['Rejected', 'Declined', 'Expired', 'Cancelled']);
  var present = {}; rows.forEach(function (r) { present[r.status] = 1; });
  return [
    { key: 'status', label: 'Status', options: statuses.filter(function (s) { return present[s]; }).map(function (s) { return [s, s]; }) },
    { key: 'owner', label: 'Owner', options: uniq(rows.map(function (r) { return r.assigned_name; })).map(function (n) { return [n, n]; }).concat([['__none', 'Unassigned']]) },
    { key: 'account', label: 'Account', options: uniq(rows.map(function (r) { return r.company; })).map(function (n) { return [n, n]; }) }
  ];
}
function applyRequestFilters(name, rows) {
  var st = filterState(name), q = (st.q || '').toLowerCase();
  return rows.filter(function (r) {
    if (st.status && r.status !== st.status) return false;
    if (st.owner === '__none' ? r.assigned_name : (st.owner && r.assigned_name !== st.owner)) return false;
    if (st.account && r.company !== st.account) return false;
    if (q && [r.id, r.company, r.contact, r.email, r.po_number, r.pi_number].concat(r.lines.map(function (l) { return l.sku + ' ' + l.name; })).join(' ').toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}

/* ---------- shared table ---------- */
function requestRows(tbId, rows, kind) {
  var tb = $(tbId);
  var cols = kind === 'order' ? 8 : 7;
  tb.innerHTML = rows.length ? '' : '<tr><td colspan="' + cols + '" class="empty" style="padding:26px 0">Nothing here</td></tr>';
  rows.forEach(function (r) {
    var tr = document.createElement('tr');
    tr.className = 'click';
    var stock = r.stock_state === 'reserved' ? '<span class="pill" style="background:var(--warn-soft);color:var(--warn)">held</span>'
      : r.stock_state === 'deducted' ? '<span class="pill" style="background:var(--ok-soft);color:var(--ok)">deducted</span>' : '—';
    var docs = (r.pi_url ? '<a href="' + esc(r.pi_url) + '" target="_blank" onclick="event.stopPropagation()">PI</a>' : '<span style="color:var(--ink-3)">—</span>') +
      ' · ' + (r.po_url ? '<a href="' + esc(r.po_url) + '" target="_blank" onclick="event.stopPropagation()">PO</a>' : '<span style="color:var(--ink-3)">—</span>');
    tr.innerHTML = '<td><b>' + esc(r.id) + '</b></td><td>' + fmtDate(kind === 'order' && r.status_dates['PO Received'] ? r.status_dates['PO Received'] : r.created) + '</td>' +
      '<td>' + esc(r.company) + '<br><small style="color:var(--ink-3)">' + esc(r.contact) + '</small></td>' +
      '<td>' + ownerCell(r) + '</td>' +
      (kind === 'order' ? '<td>' + esc(r.po_number || '—') + '</td>' : '') +
      '<td style="font-size:12px">' + docs + '</td>' +
      '<td class="num">' + inr(r.pi_total || r.total_est) + '</td>' +
      (kind === 'order' ? '<td style="font-size:12px">' + stock + '</td>' : '') +
      '<td>' + statusPill(r.status) + '</td>';
    tr.onclick = function () { openOrder(r); };
    tb.appendChild(tr);
  });
}
function requestTable(tbId, kind) {
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
    '<th>ID</th><th>' + (kind === 'order' ? 'PO received' : 'Created') + '</th><th>Account</th><th>Owner</th>' +
    (kind === 'order' ? '<th>PO no.</th>' : '') + '<th>Docs</th><th class="num">Value</th>' +
    (kind === 'order' ? '<th>Stock</th>' : '') + '<th>Status</th>' +
    '</tr></thead><tbody id="' + tbId + '"></tbody></table></div>';
}

/* ---------- enquiries ---------- */
function renderEnquiries() {
  var all = A.requests.filter(function (r) { return !isOrder(r); });
  var open = all.filter(function (r) { return ENQUIRY_STAGES.indexOf(r.status) >= 0; });
  var closed = all.filter(function (r) { return ENQUIRY_STAGES.indexOf(r.status) < 0; });
  A.enqView = A.enqView || 'open';
  var rows = A.enqView === 'open' ? open : closed;
  var count = function (st) { return open.filter(function (r) { return r.status === st; }).length; };
  $('p-enquiries').innerHTML =
    '<div class="stat-row">' +
      stat(count('New'), 'New, awaiting decision') + stat(count('Accepted'), 'Accepted, to quote') +
      stat(count('PI Sent'), 'PI with client') + stat(count('PI Accepted'), 'PI accepted, awaiting PO') +
      stat(inr(open.reduce(function (s, r) { return s + (r.pi_total || r.total_est); }, 0)), 'Open pipeline') +
    '</div>' +
    '<div class="panel-head"><h2>Enquiries</h2>' +
      '<div class="seg" id="enqSeg">' +
        '<button data-v="open" class="' + (A.enqView === 'open' ? 'on' : '') + '">Open (' + open.length + ')</button>' +
        '<button data-v="closed" class="' + (A.enqView === 'closed' ? 'on' : '') + '">Closed (' + closed.length + ')</button>' +
      '</div><span class="sp"></span>' +
      '<button class="btn small" id="eReload">Refresh</button>' +
      '<button class="btn primary small" id="rNew" style="margin-left:8px">+ Enquiry</button></div>' +
    '<p class="note" style="margin-top:-6px">An enquiry runs from New to PI Accepted. When the client\'s purchase order lands it moves to Orders.</p>' +
    filterBar('enq', requestFilterDefs(rows, 'enquiry'), 'search id, account, contact, product') +
    requestTable('eRows', 'enquiry');
  requestRows('eRows', applyRequestFilters('enq', rows), 'enquiry');
  wireFilterBar('enq', function (typing) { if (typing) requestRows('eRows', applyRequestFilters('enq', rows), 'enquiry'); else renderEnquiries(); });
  $('eReload').onclick = loadRequests;
  $('rNew').onclick = function () { newRequest(); };
  $('enqSeg').querySelectorAll('button').forEach(function (b) { b.onclick = function () { A.enqView = b.dataset.v; renderEnquiries(); }; });
}

/* ---------- orders ---------- */
function renderOrders() {
  var all = A.requests.filter(isOrder);
  var active = all.filter(function (r) { return r.active; });
  var done = all.filter(function (r) { return !r.active; });
  A.orderView = A.orderView || 'active';
  var rows = A.orderView === 'active' ? active : done;
  var count = function (st) { return active.filter(function (r) { return r.status === st; }).length; };
  $('p-orders').innerHTML =
    '<div class="stat-row">' +
      stat(count('PO Received'), 'PO received') + stat(count('In Production'), 'In production') + stat(count('Dispatched'), 'Dispatched') +
      stat(inr(active.reduce(function (s, r) { return s + (r.pi_total || r.total_est); }, 0)), 'Active order value') +
    '</div>' +
    '<div class="panel-head"><h2>Orders</h2>' +
      '<div class="seg" id="ordSeg">' +
        '<button data-v="active" class="' + (A.orderView === 'active' ? 'on' : '') + '">Active (' + active.length + ')</button>' +
        '<button data-v="done" class="' + (A.orderView === 'done' ? 'on' : '') + '">Completed (' + done.length + ')</button>' +
      '</div><span class="sp"></span>' +
      '<button class="btn small" id="oReload">Refresh</button></div>' +
    '<p class="note" style="margin-top:-6px">Converted enquiries: a purchase order is on file. Active runs from PO Received to Dispatched; Delivered, Closed and Cancelled are completed.</p>' +
    filterBar('ord', requestFilterDefs(rows, 'order'), 'search id, account, PO number, product') +
    requestTable('oRows', 'order');
  requestRows('oRows', applyRequestFilters('ord', rows), 'order');
  wireFilterBar('ord', function (typing) { if (typing) requestRows('oRows', applyRequestFilters('ord', rows), 'order'); else renderOrders(); });
  $('oReload').onclick = loadRequests;
  $('ordSeg').querySelectorAll('button').forEach(function (b) { b.onclick = function () { A.orderView = b.dataset.v; renderOrders(); }; });
}

/* ---------- my enquiries ---------- */
function renderMine() {
  var mine = A.requests.filter(isMine);
  var enq = mine.filter(function (r) { return !isOrder(r) && ENQUIRY_STAGES.indexOf(r.status) >= 0; });
  var ord = mine.filter(function (r) { return isOrder(r) && r.active; });
  var closed = mine.filter(function (r) { return enq.indexOf(r) < 0 && ord.indexOf(r) < 0; });
  var me = A.user || {};
  $('p-mine').innerHTML =
    '<div class="panel-head"><h2>My enquiries</h2><span class="sp"></span><button class="btn small" id="mReload">Refresh</button>' +
      '<button class="btn primary small" id="rNew2" style="margin-left:8px">+ Enquiry</button></div>' +
    '<p class="note" style="margin-top:-6px">Everything assigned to ' + esc(me.name || 'you') + ' for follow-up' + (me.email ? '' : ' (master key: matched by name)') + '. Reassign from inside an enquiry.</p>' +
    '<div class="stat-row">' + stat(enq.length, 'open enquiries') + stat(ord.length, 'active orders') +
      stat(enq.filter(function (r) { return r.status === 'New'; }).length, 'need a decision') +
      stat(enq.filter(function (r) { return r.status === 'PI Sent'; }).length, 'PI awaiting reply') + '</div>' +
    filterBar('mine', [{ key: 'status', label: 'Status', options: uniq(mine.map(function (r) { return r.status; })).map(function (s) { return [s, s]; }) }], 'search id, account, contact, product') +
    '<h3 style="margin:14px 0 6px">Open enquiries</h3>' + requestTable('mRowsE', 'enquiry') +
    '<h3 style="margin:18px 0 6px">Active orders</h3>' + requestTable('mRowsO', 'order') +
    (closed.length ? '<details style="margin-top:16px"><summary style="cursor:pointer;font-weight:700;color:var(--ink-2)">Completed and closed (' + closed.length + ')</summary>' + requestTable('mRowsC', 'enquiry') + '</details>' : '');
  function paintMine() {
    requestRows('mRowsE', applyRequestFilters('mine', enq), 'enquiry');
    requestRows('mRowsO', applyRequestFilters('mine', ord), 'order');
    if (closed.length) requestRows('mRowsC', applyRequestFilters('mine', closed), 'enquiry');
  }
  paintMine();
  wireFilterBar('mine', function (typing) { if (typing) paintMine(); else renderMine(); });
  $('mReload').onclick = loadRequests;
  $('rNew2').onclick = function () { newRequest(); };
}

/* ---------- generic dropdown picker (company, contact, anything) ---------- */
/**
 * items: array; opts.text(item) label, opts.sub(item) small line, opts.value(item) what goes in the input,
 * opts.onPick(item), opts.free: true keeps free text allowed (a new name), opts.empty: message when nothing matches.
 */
function attachPicker(input, panel, items, opts) {
  var idx = -1, shown = [];
  function list() { return typeof items === 'function' ? items() : items; }
  function rows() {
    var q = input.value.trim().toLowerCase();
    return list().filter(function (it) {
      return !q || (opts.text(it) + ' ' + (opts.sub ? opts.sub(it) : '')).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 40);
  }
  function paint() {
    shown = rows(); idx = -1;
    panel.innerHTML = shown.length ? shown.map(function (it, i) {
      return '<div class="ppick-row" data-i="' + i + '"><div class="ppick-txt"><b>' + esc(opts.text(it)) + '</b>' +
        (opts.sub && opts.sub(it) ? '<small>' + esc(opts.sub(it)) + '</small>' : '') + '</div></div>';
    }).join('') : '<div class="ppick-none">' + esc(opts.empty || 'No match') + (opts.free && input.value.trim() ? ' · keeping "' + esc(input.value.trim()) + '" as typed' : '') + '</div>';
    panel.hidden = false;
    panel.querySelectorAll('.ppick-row').forEach(function (r) {
      r.onmousedown = function (e) { e.preventDefault(); pick(shown[Number(r.dataset.i)]); };
    });
  }
  function pick(it) {
    if (!it) return;
    input.value = opts.value ? opts.value(it) : opts.text(it);
    panel.hidden = true;
    if (opts.onPick) opts.onPick(it);
  }
  function move(d) {
    var els = panel.querySelectorAll('.ppick-row');
    if (!els.length) return;
    idx = (idx + d + els.length) % els.length;
    els.forEach(function (el, i) { el.classList.toggle('on', i === idx); });
    els[idx].scrollIntoView({ block: 'nearest' });
  }
  input.addEventListener('focus', paint);
  input.addEventListener('input', function () { paint(); if (opts.onType) opts.onType(input.value); });
  input.addEventListener('blur', function () { setTimeout(function () { panel.hidden = true; }, 120); });
  input.addEventListener('keydown', function (e) {
    if (panel.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { paint(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { if (idx >= 0) { e.preventDefault(); pick(shown[idx]); } else if (!panel.hidden) { e.preventDefault(); panel.hidden = true; } }
    else if (e.key === 'Escape') { if (!panel.hidden) { panel.hidden = true; e.stopPropagation(); } }
  });
  return { refresh: paint, close: function () { panel.hidden = true; } };
}
function pickerField(id, label, placeholder, extra) {
  return '<div class="field"' + (extra || '') + '><label>' + label + '</label><div class="ppick-wrap">' +
    '<input id="' + id + '" placeholder="' + esc(placeholder || '') + '" autocomplete="off"><div class="ppick" id="' + id + 'Pick" hidden></div></div></div>';
}

/* ================= ACCOUNTS ================= */
function loadCompanies() {
  A.loaded.accounts = true;
  $('p-accounts').innerHTML = '<div class="spin"></div>';
  api('adminCompanies').then(function (res) {
    A.companies = res.companies;
    A.contacts = res.contacts;
    A.unlinked = { names: res.unlinked_names, orders: res.unlinked_orders };
    if (A.accountOpen) {
      var c = A.companies.filter(function (x) { return x.id === A.accountOpen; })[0];
      if (c) return openAccount(c);
      A.accountOpen = '';
    }
    renderCompanies();
  }).catch(function (e) { $('p-accounts').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
}
function contactsOf(companyId) { return A.contacts.filter(function (c) { return c.company_id === companyId; }); }
function addrLines(a) {
  if (!a) return '';
  return [a.line1, a.line2, a.city, [a.state, a.pin].filter(String).join(' '), a.country].filter(String).map(esc).join('<br>');
}

function renderCompanies() {
  A.accountOpen = '';
  var u = A.unlinked || { names: 0, orders: 0 };
  var st = filterState('acc'), q = (st.q || '').toLowerCase();
  var rows = A.companies.filter(function (c) {
    if (st.owner === '__none' ? c.owner : (st.owner && c.owner !== st.owner)) return false;
    if (st.active === 'yes' && !c.active) return false;
    if (st.active === 'no' && c.active) return false;
    if (st.state && (c.bill && c.bill.state) !== st.state) return false;
    return !q || (c.name + ' ' + c.gstin + ' ' + (c.owner || '') + ' ' + (c.bill && c.bill.city || '')).toLowerCase().indexOf(q) >= 0;
  });
  $('p-accounts').innerHTML =
    '<div class="panel-head"><h2>Accounts</h2>' +
      '<span class="sp"></span>' +
      '<button class="btn primary small" id="coNew">+ Account</button></div>' +
    '<p class="note" style="margin-top:-6px">Customer accounts, the people at them, and what has been said and filed about each. Enquiries and orders attach to an account.</p>' +
    (u.names
      ? '<div class="note2 warn"><strong>' + u.orders + ' enquir' + (u.orders === 1 ? 'y' : 'ies') + ' across ' + u.names + ' company name' + (u.names === 1 ? '' : 's') +
        ' are not linked to an account.</strong> Import groups them by name, creates one account each and lifts the contact from the most recent one. It is safe to run more than once. ' +
        '<button class="btn small" id="coImport" style="margin-left:8px">Import from enquiries</button><span id="coImportOut" class="note" style="margin-left:10px"></span></div>'
      : '') +
    filterBar('acc', [
      { key: 'owner', label: 'Owner', options: uniq(A.companies.map(function (c) { return c.owner; })).map(function (n) { return [n, n]; }).concat([['__none', 'No owner']]) },
      { key: 'state', label: 'State', options: uniq(A.companies.map(function (c) { return c.bill && c.bill.state; })).map(function (n) { return [n, n]; }) },
      { key: 'active', label: 'Status', options: [['yes', 'Active'], ['no', 'Inactive']] }
    ], 'search name, GSTIN, owner, city') +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>Account</th><th>City</th><th>Owner</th><th class="num">Contacts</th><th class="num">Enquiries</th><th class="num">Value</th><th>Active</th>' +
    '</tr></thead><tbody id="coRows"></tbody></table></div>';
  var tb = $('coRows');
  if (!rows.length) tb.innerHTML = '<tr><td colspan="7"><div class="empty" style="padding:26px 0">' + (A.companies.length ? 'No account matches.' : 'No accounts yet.') + '</div></td></tr>';
  rows.forEach(function (c) {
    var tr = document.createElement('tr');
    tr.className = 'click';
    tr.innerHTML = '<td><b>' + esc(c.name) + '</b><br><small style="color:var(--ink-3)">' + esc(c.id) + (c.gstin ? ' · ' + esc(c.gstin) : '') + '</small></td>' +
      '<td>' + esc(c.bill && c.bill.city || '—') + '</td>' +
      '<td>' + esc(c.owner || '—') + '</td>' +
      '<td class="num">' + c.contacts + '</td><td class="num">' + c.orders + '</td><td class="num">' + inr(c.value) + '</td>' +
      '<td>' + (c.active ? '<span class="badge in">active</span>' : '<span class="badge out">inactive</span>') + '</td>';
    tr.onclick = function () { openAccount(c); };
    tb.appendChild(tr);
  });
  $('coNew').onclick = function () { editCompany(null); };
  wireFilterBar('acc', function (typing) {
    if (!typing) { renderCompanies(); return; }
    var inp = document.querySelector('#fb-acc input'), pos = inp.selectionStart;
    renderCompanies(); var again = document.querySelector('#fb-acc input'); again.focus(); again.setSelectionRange(pos, pos);
  });
  if ($('coImport')) $('coImport').onclick = function () {
    $('coImport').disabled = true; $('coImportOut').textContent = 'Importing…';
    api('adminCompanyImport').then(function (res) { toast('Imported ' + res.created + ' account' + (res.created === 1 ? '' : 's')); loadCompanies(); })
      .catch(function (e) { $('coImport').disabled = false; $('coImportOut').textContent = e.message; });
  };
}

/* The account page: everything about one customer in one place. */
function openAccount(c) {
  A.accountOpen = c.id;
  var me = A.user || {};
  var people = contactsOf(c.id);
  var related = (A.requests || []).filter(function (r) { return r.company_id === c.id; });
  $('p-accounts').innerHTML =
    '<div style="margin-bottom:10px"><a href="#" id="acBack" style="font-weight:700">← Accounts</a></div>' +
    '<div class="panel-head" style="align-items:flex-start"><div><h2 style="margin:0">' + esc(c.name) + ' ' + (c.active ? '' : '<span class="badge out">inactive</span>') + '</h2>' +
      '<div class="note" style="margin:4px 0 0">' + esc(c.id) + (c.gstin ? ' · GSTIN ' + esc(c.gstin) : '') + (c.owner ? ' · owner ' + esc(c.owner) : ' · no owner') + '</div></div>' +
      '<span class="sp"></span>' +
      '<button class="btn small" id="acEnq">+ Enquiry</button> <button class="btn primary small" id="acEdit" style="margin-left:8px">Edit account</button></div>' +
    '<div class="stat-row">' + stat(people.length, 'contacts') + stat(related.filter(function (r) { return !isOrder(r); }).length, 'enquiries') +
      stat(related.filter(isOrder).length, 'orders') + stat(inr(c.value), 'lifetime value') + '</div>' +
    '<div class="two-col" style="margin-bottom:18px">' +
      '<div class="card-block"><h3>Billing address</h3>' + (addrLines(c.bill) || esc(c.billing_address || '—')) + '</div>' +
      '<div class="card-block"><h3>Shipping address</h3>' + (c.ship_same ? '<span class="note" style="margin:0">Same as billing</span>' : (addrLines(c.ship) || esc(c.ship_address || '—'))) +
        '<div class="note" style="margin:10px 0 0">' + (c.phone ? esc(c.phone) + ' · ' : '') + (c.email ? '<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>' : '') +
        (c.state_code ? '<br>Place of supply ' + esc(stateName(c.state_code) || c.state_code) + ' (' + esc(c.state_code) + ')' : '') + '</div></div>' +
    '</div>' +
    (c.notes ? '<div class="note2" style="margin-bottom:18px"><b>Account note:</b> ' + esc(c.notes) + '</div>' : '') +

    '<div class="section-head"><h2 style="font-size:16px">Contacts</h2></div>' +
    '<div id="acContacts"></div><button class="btn small" id="acContactNew" style="margin:8px 0 18px">+ Contact</button>' +

    '<div class="section-head"><h2 style="font-size:16px">Enquiries and orders</h2></div>' +
    requestTable('acRows', 'enquiry') +

    '<div class="two-col" style="margin-top:18px">' +
      '<div><div class="section-head"><h2 style="font-size:16px">Notes</h2><div class="note-sub">Dated, in the author\'s name. What was discussed, agreed, promised.</div></div>' +
        '<div class="field"><textarea id="acNoteText" placeholder="add a note" style="min-height:64px"></textarea></div>' +
        '<button class="btn small" id="acNoteAdd" style="margin-bottom:10px">Add note</button>' +
        '<div id="acNotes"><div class="spin"></div></div></div>' +
      '<div><div class="section-head"><h2 style="font-size:16px">Attachments</h2><div class="note-sub">Filed under Merchforce / Accounts / ' + esc(c.id) + ' in Drive.</div></div>' +
        '<label class="btn small" for="acFile" style="cursor:pointer;margin-bottom:10px">Upload a file</label><input id="acFile" type="file" class="sr-only" multiple>' +
        '<span class="note" id="acFileOut" style="margin-left:8px"></span>' +
        '<div id="acFiles"><div class="spin"></div></div></div>' +
    '</div>';

  $('acBack').onclick = function (e) { e.preventDefault(); renderCompanies(); };
  $('acEdit').onclick = function () { editCompany(c); };
  $('acEnq').onclick = function () { newRequest(c); };
  requestRows('acRows', related, 'enquiry');

  function paintContacts() {
    var rows = contactsOf(c.id);
    $('acContacts').innerHTML = rows.length
      ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Consent</th><th></th></tr></thead><tbody>' +
        rows.map(function (ct) {
          return '<tr class="click" data-ct="' + esc(ct.id) + '"><td><b>' + esc(ct.name || '—') + '</b></td><td>' + esc(ct.email || '—') + '</td><td>' + esc(ct.phone || '—') + '</td><td>' + esc(ct.role || '—') + '</td>' +
            '<td>' + (ct.unsubscribed ? '<span style="color:var(--bad)">unsubscribed</span>' : ct.consent ? '<span style="color:var(--ok)">yes</span>' : 'no') + '</td>' +
            '<td class="num"><button class="btn small" data-del="' + esc(ct.id) + '">Remove</button></td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="empty" style="padding:14px 0">Nobody recorded at this account yet.</div>';
    $('acContacts').querySelectorAll('tr[data-ct]').forEach(function (tr) {
      tr.onclick = function (ev) { if (ev.target.dataset.del) return; editContact(c.id, A.contacts.filter(function (x) { return x.id === tr.dataset.ct; })[0], paintContacts); };
    });
    $('acContacts').querySelectorAll('button[data-del]').forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        if (!confirm('Remove this contact?')) return;
        b.disabled = true;
        api('adminContactDelete', { id: b.dataset.del }).then(function () {
          A.contacts = A.contacts.filter(function (x) { return x.id !== b.dataset.del; }); paintContacts(); toast('Contact removed');
        }).catch(function (e) { b.disabled = false; toast(e.message); });
      };
    });
  }
  paintContacts();
  $('acContactNew').onclick = function () { editContact(c.id, null, paintContacts); };

  function paintNotes(notes) {
    $('acNotes').innerHTML = notes.length ? notes.map(function (n) {
      return '<div class="card-block" style="padding:10px 14px;margin-bottom:8px"><div style="display:flex;gap:8px;align-items:baseline"><b style="font-size:13px">' + esc(n.author) + '</b>' +
        '<small style="color:var(--ink-3)">' + fmtDate(n.ts) + '</small><span class="sp"></span><button class="btn ghost small" data-ndel="' + esc(n.id) + '">×</button></div>' +
        '<div style="white-space:pre-wrap;font-size:13.5px;margin-top:4px">' + esc(n.text) + '</div></div>';
    }).join('') : '<div class="empty" style="padding:14px 0">No notes yet.</div>';
    $('acNotes').querySelectorAll('button[data-ndel]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('Delete this note?')) return;
        api('adminAccountNoteDelete', { id: b.dataset.ndel }).then(function () { toast('Note deleted'); loadExtras(); }).catch(function (e) { toast(e.message); });
      };
    });
  }
  function paintFiles(files) {
    $('acFiles').innerHTML = files.length ? '<div class="tbl-wrap"><table class="tbl"><tbody>' + files.map(function (f) {
      return '<tr><td><a href="' + esc(f.url) + '" target="_blank"><b>' + esc(f.name) + '</b></a><br><small style="color:var(--ink-3)">' + esc(f.uploaded_by) + ' · ' + fmtDate(f.ts) + (f.size ? ' · ' + Math.max(1, Math.round(f.size / 1024)) + ' KB' : '') + '</small></td>' +
        '<td class="num"><button class="btn small" data-fdel="' + esc(f.id) + '">×</button></td></tr>';
    }).join('') + '</tbody></table></div>' : '<div class="empty" style="padding:14px 0">Nothing filed yet.</div>';
    $('acFiles').querySelectorAll('button[data-fdel]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('Delete this file from Drive?')) return;
        api('adminAccountFileDelete', { id: b.dataset.fdel }).then(function () { toast('File deleted'); loadExtras(); }).catch(function (e) { toast(e.message); });
      };
    });
  }
  function loadExtras() {
    return api('adminAccountNotes', { company_id: c.id }).then(function (res) { paintNotes(res.notes); paintFiles(res.files); })
      .catch(function (e) { $('acNotes').innerHTML = '<div class="empty" style="padding:14px 0">' + esc(e.message) + '</div>'; $('acFiles').innerHTML = ''; });
  }
  loadExtras();
  $('acNoteAdd').onclick = function () {
    var text = $('acNoteText').value.trim();
    if (!text) return;
    $('acNoteAdd').disabled = true;
    api('adminAccountNoteSave', { company_id: c.id, text: text }).then(function () { $('acNoteText').value = ''; toast('Note added'); return loadExtras(); })
      .catch(function (e) { toast(e.message); }).then(function () { $('acNoteAdd').disabled = false; });
  };
  $('acFile').onchange = function () {
    var files = Array.prototype.slice.call(this.files || []);
    if (!files.length) return;
    var done = 0;
    $('acFileOut').textContent = 'Uploading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…';
    files.reduce(function (chain, f) {
      return chain.then(function () {
        return new Promise(function (resolve, reject) {
          if (f.size > 10 * 1024 * 1024) { reject(new Error(f.name + ' is over 10MB')); return; }
          var rd = new FileReader();
          rd.onload = function () { api('adminAccountFileUpload', { company_id: c.id, filename: f.name, mime: f.type || 'application/octet-stream', data: rd.result }).then(function () { done++; resolve(); }, reject); };
          rd.onerror = function () { reject(new Error('Could not read ' + f.name)); };
          rd.readAsDataURL(f);
        });
      });
    }, Promise.resolve()).then(function () { $('acFileOut').textContent = ''; toast(done + ' file' + (done === 1 ? '' : 's') + ' filed'); })
      .catch(function (e) { $('acFileOut').textContent = e.message; }).then(function () { $('acFile').value = ''; loadExtras(); });
  };
}

function addrFields(pfx, a) {
  a = a || {};
  return '<div class="field"><label>Address line 1</label><input id="' + pfx + 'L1" value="' + esc(a.line1 || '') + '"></div>' +
    '<div class="field"><label>Address line 2</label><input id="' + pfx + 'L2" value="' + esc(a.line2 || '') + '"></div>' +
    '<div class="f2">' +
      '<div class="field"><label>City</label><input id="' + pfx + 'City" value="' + esc(a.city || '') + '"></div>' +
      '<div class="field"><label>State</label><select id="' + pfx + 'State">' + stateOptions(stateCode(a.state), 'Choose a state') + '</select></div>' +
      '<div class="field"><label>PIN code</label><input id="' + pfx + 'Pin" value="' + esc(a.pin || '') + '" maxlength="10"></div>' +
      '<div class="field"><label>Country</label><input id="' + pfx + 'Country" value="' + esc(a.country || 'India') + '"></div>' +
    '</div>';
}
function readAddr(pfx) {
  return { line1: $(pfx + 'L1').value.trim(), line2: $(pfx + 'L2').value.trim(), city: $(pfx + 'City').value.trim(),
           state: stateName($(pfx + 'State').value), pin: $(pfx + 'Pin').value.trim(), country: $(pfx + 'Country').value.trim() };
}

function editCompany(c) {
  var isNew = !c;
  c = c || { id: '', name: '', gstin: '', phone: '', email: '', billing_address: '', ship_address: '', state_code: '', owner: '', owner_email: '', notes: '', active: true, orders: 0, bill: {}, ship: {}, ship_same: true };
  staffList().then(function (staff) {
    openDrawer(
      '<h2 style="margin:0 0 14px">' + (isNew ? 'New account' : esc(c.name)) + '</h2>' +
      '<div class="field"><label>Account name *</label><input id="cName" value="' + esc(c.name) + '"></div>' +
      '<div class="f2">' +
        '<div class="field"><label>GSTIN</label><input id="cGstin" value="' + esc(c.gstin) + '" maxlength="15" placeholder="15 characters"></div>' +
        '<div class="field"><label>Account owner</label><select id="cOwner">' + staffOptions(staff, c.owner_email, 'Nobody yet') + '</select></div>' +
        '<div class="field"><label>Phone</label><input id="cPhone" value="' + esc(c.phone) + '"></div>' +
        '<div class="field"><label>Email</label><input id="cEmail" value="' + esc(c.email) + '"></div>' +
      '</div>' +
      '<div class="section-head" style="margin-top:8px"><h2 style="font-size:15px">Billing address</h2></div>' + addrFields('cb', c.bill) +
      '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:14px;margin:6px 0 10px"><input id="cSame" type="checkbox"' + (c.ship_same !== false ? ' checked' : '') + '> Shipping address is the same as billing</label>' +
      '<div id="cShipWrap"' + (c.ship_same !== false ? ' hidden' : '') + '><div class="section-head"><h2 style="font-size:15px">Shipping address</h2></div>' + addrFields('cs', c.ship) + '</div>' +
      '<div class="f2">' +
        '<div class="field"><label>Notes</label><input id="cNotes" value="' + esc(c.notes) + '"></div>' +
        '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:14px;margin-top:20px"><input id="cActive" type="checkbox"' + (c.active ? ' checked' : '') + '> Active</label>' +
      '</div>' +
      '<p class="note">Place of supply for GST is taken from the billing state, or from the GSTIN when there is no state.</p>' +
      '<div class="form-err" id="mErr"></div>' +
      '<div style="display:flex;gap:10px;margin-top:16px">' +
        (isNew || c.orders ? '' : '<button class="btn danger" id="cDel">Delete</button>') +
        '<button class="btn primary" id="cSave" style="flex:1;justify-content:center">Save account</button>' +
      '</div>' +
      (!isNew && c.orders ? '<p class="note" style="margin-top:8px">This account has ' + c.orders + ' enquir' + (c.orders === 1 ? 'y' : 'ies') + ' against it, so it cannot be deleted. Untick Active to retire it.</p>' : ''));

    $('cSame').onchange = function () { $('cShipWrap').hidden = this.checked; };
    if ($('cDel')) $('cDel').onclick = function () {
      if (!confirm('Delete this account and its contacts?')) return;
      api('adminCompanyDelete', { id: c.id }).then(function () { closeDrawer(); toast('Account deleted'); A.accountOpen = ''; loadCompanies(); })
        .catch(function (e) { $('mErr').textContent = e.message; });
    };
    $('cSave').onclick = function () {
      var gstin = $('cGstin').value.trim().toUpperCase();
      if (gstin && gstin.length !== 15) { $('mErr').textContent = 'A GSTIN is 15 characters. Leave it blank if you do not have it yet.'; return; }
      var same = $('cSame').checked;
      var ownerEmail = $('cOwner').value;
      var owner = staff.filter(function (u) { return u.email === ownerEmail; })[0];
      $('cSave').disabled = true;
      api('adminCompanySave', { company: {
        id: c.id, name: $('cName').value.trim(), gstin: gstin,
        phone: $('cPhone').value.trim(), email: $('cEmail').value.trim(),
        owner_email: ownerEmail, owner: owner ? owner.name : '',
        bill: readAddr('cb'), ship_same: same, ship: same ? undefined : readAddr('cs'),
        notes: $('cNotes').value.trim(), active: $('cActive').checked
      } }).then(function (res) { closeDrawer(); toast('Account saved'); A.accountOpen = res.id || c.id; loadCompanies(); })
        .catch(function (e) { $('cSave').disabled = false; $('mErr').textContent = e.message; });
    };
  });
}

/* ================= UNIVERSAL SEARCH ================= */
function searchReady() {
  var need = [];
  if (!A.products.length) need.push(api('adminCatalog').then(function (res) { A.products = res.products; A.brands = res.brands; }));
  if (!A.requestsAt) need.push(loadRequests());
  if (!A.companies.length && !A.loaded.accounts) need.push(api('adminCompanies').then(function (res) { A.companies = res.companies; A.contacts = res.contacts; }).catch(function () {}));
  return Promise.all(need);
}
function searchAll(q) {
  q = q.toLowerCase();
  var hit = function (s) { return String(s || '').toLowerCase().indexOf(q) >= 0; };
  var products = A.products.filter(function (p) { return hit(p.sku) || hit(p.name) || hit(brandName(p.brand_id)) || hit(p.category) || hit(p.hsn); }).slice(0, 8);
  var requests = (A.requests || []).filter(function (r) {
    return hit(r.id) || hit(r.company) || hit(r.contact) || hit(r.email) || hit(r.po_number) || hit(r.pi_number) || r.lines.some(function (l) { return hit(l.sku) || hit(l.name); });
  }).slice(0, 8);
  var companies = (A.companies || []).filter(function (c) { return hit(c.name) || hit(c.gstin) || hit(c.id) || hit(c.owner); }).slice(0, 6);
  var contacts = (A.contacts || []).filter(function (c) { return hit(c.name) || hit(c.email) || hit(c.phone); }).slice(0, 6);
  return { products: products, requests: requests, companies: companies, contacts: contacts };
}
function wireSearch() {
  var input = $('gSearch'), panel = $('gSearchPick');
  if (!input) return;
  var timer = null;
  function group(title, rows) { return rows ? '<div class="gs-group">' + title + '</div>' + rows : ''; }
  function paint() {
    var q = input.value.trim();
    if (q.length < 2) { panel.hidden = true; return; }
    searchReady().then(function () {
      var r = searchAll(q);
      var compById = {}; (A.companies || []).forEach(function (c) { compById[c.id] = c; });
      var html =
        group('Products', r.products.map(function (p) {
          return '<div class="ppick-row" data-k="p" data-id="' + esc(p.sku) + '">' + thumb(p, 36) + '<div class="ppick-txt"><b>' + esc(p.name) + '</b><small>' + esc(p.sku) + ' · ' + esc(brandName(p.brand_id)) + ' · MOQ ' + p.moq + ' · ' + (p.atp > 0 ? qty(p.atp) + ' available' : 'out of stock') + (p.tiers && p.tiers[0] ? ' · from ' + inr(p.tiers[0].price) : '') + '</small></div></div>';
        }).join('')) +
        group('Enquiries and orders', r.requests.map(function (x) {
          return '<div class="ppick-row" data-k="r" data-id="' + esc(x.id) + '"><div class="ppick-txt"><b>' + esc(x.id) + ' · ' + esc(x.company) + '</b><small>' + esc(x.status) + ' · ' + esc(x.contact) + ' · ' + inr(x.pi_total || x.total_est) + (x.po_number ? ' · PO ' + esc(x.po_number) : '') + '</small></div></div>';
        }).join('')) +
        group('Accounts', r.companies.map(function (c) {
          return '<div class="ppick-row" data-k="c" data-id="' + esc(c.id) + '"><div class="ppick-txt"><b>' + esc(c.name) + '</b><small>' + esc(c.id) + (c.gstin ? ' · ' + esc(c.gstin) : '') + ' · ' + c.orders + ' enquir' + (c.orders === 1 ? 'y' : 'ies') + (c.owner ? ' · ' + esc(c.owner) : '') + '</small></div></div>';
        }).join('')) +
        group('Contacts', r.contacts.map(function (ct) {
          var co = compById[ct.company_id];
          return '<div class="ppick-row" data-k="ct" data-id="' + esc(ct.company_id) + '"><div class="ppick-txt"><b>' + esc(ct.name || ct.email) + '</b><small>' + esc(ct.email || '') + (ct.phone ? ' · ' + esc(ct.phone) : '') + (co ? ' · ' + esc(co.name) : '') + '</small></div></div>';
        }).join(''));
      panel.innerHTML = html || '<div class="ppick-none">Nothing matches "' + esc(q) + '"</div>';
      panel.hidden = false;
      panel.querySelectorAll('.ppick-row').forEach(function (row) {
        row.onmousedown = function (e) {
          e.preventDefault(); panel.hidden = true; input.value = '';
          var id = row.dataset.id;
          if (row.dataset.k === 'p') viewProduct(A.products.filter(function (p) { return p.sku === id; })[0]);
          if (row.dataset.k === 'r') { var rq = A.requests.filter(function (x) { return x.id === id; })[0]; goTab(isOrder(rq) ? 'orders' : 'enquiries'); openOrder(rq); }
          if (row.dataset.k === 'c' || row.dataset.k === 'ct') { goTab('accounts'); var co = (A.companies || []).filter(function (x) { return x.id === id; })[0]; if (co) openAccount(co); }
        };
      });
    });
  }
  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(paint, 120); });
  input.addEventListener('focus', function () { if (input.value.trim().length >= 2) paint(); });
  input.addEventListener('blur', function () { setTimeout(function () { panel.hidden = true; }, 150); });
  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('mOverlay').hidden) { closeDrawer(); return; }
    input.value = ''; panel.hidden = true; input.blur(); e.stopPropagation();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('console').hidden) { e.preventDefault(); input.focus(); }
  });
}
function goTab(name) {
  var chip = document.querySelector('#tabs .chip[data-t="' + name + '"]');
  if (chip && !chip.classList.contains('on')) chip.click();
}

/* Read-only product card for answering an enquiry quickly. */
function viewProduct(p) {
  if (!p) return;
  var specs = Array.isArray(p.specs) ? p.specs : String(p.specs || '').split('|').map(function (s) { return s.trim(); }).filter(String);
  openDrawer(
    '<div style="display:flex;gap:16px;align-items:flex-start">' +
      '<div style="width:160px;height:160px;border-radius:12px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center;flex:none">' + (p.images[0] ? '<img src="' + esc(p.images[0]) + '" style="max-width:150px;max-height:150px;object-fit:contain">' : '') + '</div>' +
      '<div style="min-width:0"><div class="note" style="margin:0;font-weight:700;letter-spacing:.05em;text-transform:uppercase;font-size:11px">' + esc(brandName(p.brand_id)) + (p.category ? ' · ' + esc(p.category) : '') + '</div>' +
        '<h2 style="margin:4px 0 2px">' + esc(p.name) + '</h2>' +
        '<div class="note" style="margin:0 0 10px">' + esc(p.sku) + (p.hsn ? ' · HSN ' + esc(p.hsn) : '') + (p.gst_rate !== undefined ? ' · GST ' + esc(String(p.gst_rate)) + '%' : '') + '</div>' +
        '<div style="font-weight:700">MOQ ' + p.moq + (p.lead_time ? ' · Lead time ' + esc(p.lead_time) : '') + '</div>' +
        '<div style="font-weight:700;margin-top:6px;color:' + (p.atp > 0 ? 'var(--ok)' : 'var(--bad)') + '">' + (p.atp > 0 ? qty(p.atp) + ' available to promise' : 'Out of stock') + '<span class="note" style="margin:0 0 0 8px;font-weight:400">on hand ' + qty(p.on_hand) + ' · reserved ' + qty(p.reserved) + '</span></div>' +
      '</div></div>' +
    (specs.length ? '<ul style="margin:14px 0 0 18px;padding:0">' + specs.map(function (s) { return '<li style="margin-bottom:3px">' + esc(s) + '</li>'; }).join('') + '</ul>' : '') +
    (p.tiers && p.tiers.length ? '<div class="tbl-wrap" style="margin-top:14px"><table class="tbl"><thead><tr>' + p.tiers.map(function (t) { return '<th class="num">' + qty(t.min) + '+ units</th>'; }).join('') + '</tr></thead>' +
      '<tbody><tr>' + p.tiers.map(function (t) { return '<td class="num"><b>' + inr(t.price) + '</b></td>'; }).join('') + '</tr></tbody></table></div><p class="note">Per unit, ex-GST' + (p.mrp ? ' · MRP ' + inr(p.mrp) : '') + '</p>' : '') +
    (p.description ? '<p style="font-size:13.5px">' + esc(p.description) + '</p>' : '') +
    '<div style="display:flex;gap:10px;margin-top:14px"><button class="btn primary" id="vpEnq" style="flex:1;justify-content:center">Raise an enquiry with this</button><button class="btn" id="vpEdit">Edit in catalogue</button></div>');
  $('vpEnq').onclick = function () { newRequest(null, p); };
  $('vpEdit').onclick = function () { goTab('catalog'); editProduct(p); };
}


function orderTimeline(r) {
  var done = STAGES.indexOf(r.status);
  if (['Rejected', 'Declined', 'Expired', 'Cancelled'].indexOf(r.status) >= 0) {
    return '<div class="note2 warn"><b>' + esc(r.status) + '</b> — closed. ' +
      (r.stock_state ? 'Stock state: ' + esc(r.stock_state) : 'No stock held.') + '</div>';
  }
  return '<div class="stage-row">' + STAGES.map(function (st, i) {
    var cls = i < done ? 'done' : (i === done ? 'now' : '');
    var when = r.status_dates[st] ? new Date(r.status_dates[st]) : null;
    return '<div class="stage ' + cls + '"><span class="dot"></span><span class="lbl">' + esc(st) + '</span>' +
      (when && !isNaN(when) ? '<span class="when">' + when.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + '</span>' : '') + '</div>';
  }).join('') + '</div>';
}

function openOrder(r) {
  var link = A.siteUrl ? A.siteUrl + '/order.html?t=' + r.token : '';
  var next = '';
  if (r.status === 'New') {
    next = '<button class="btn primary small" id="oAccept">Accept enquiry</button> ' +
           '<button class="btn danger small" id="oReject">Reject</button>';
  } else if (['Accepted', 'PI Sent'].indexOf(r.status) >= 0) {
    next = '<button class="btn primary small" id="oQuote">' + (r.pi_number ? 'Revise quotation' : 'Create quotation (PI)') + '</button> ' +
           '<button class="btn small" id="oPiUp">Upload PI instead</button>';
  } else if (r.status === 'PI Accepted') {
    next = '<button class="btn primary small" id="oPoUp">Upload purchase order</button>';
  } else if (['PO Received', 'In Production', 'Dispatched'].indexOf(r.status) >= 0) {
    next = '<button class="btn primary small" id="oShip">Add shipment</button>';
  }

  openDrawer(
    '<h2 style="margin:0 0 2px">' + esc(r.id) + ' ' + statusPill(r.status) + '</h2>' +
    '<p style="color:var(--ink-3);margin:0 0 14px;font-size:13.5px">' + esc(r.company) + ' · ' + fmtDate(r.created) + '</p>' +
    orderTimeline(r) +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' + next +
      (link ? ' <button class="btn small" id="oLink">Copy client link</button>' : '') + '</div>' +
    '<div class="two-col" style="margin-bottom:14px">' +
      '<div class="card-block"><h3>Buyer</h3><b>' + esc(r.company) + '</b><br>' + esc(r.contact) + '<br>' +
        '<a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a><br>' + esc(r.phone || '') +
        (r.gstin ? '<br>GSTIN: ' + esc(r.gstin) : '') + '</div>' +
      '<div class="card-block"><h3>Documents</h3>' +
        (r.pi_url ? 'PI <b>' + esc(r.pi_number) + '</b> · ' + inr(r.pi_total) +
          (r.pi_valid_till ? ' · valid till ' + esc(r.pi_valid_till) : '') +
          '<br><a href="' + esc(r.pi_url) + '" target="_blank">Open PI ↗</a><br>' : '<span style="color:var(--ink-3)">No PI yet</span><br>') +
        (r.po_url ? 'PO ' + esc(r.po_number || '') + '<br><a href="' + esc(r.po_url) + '" target="_blank">Open PO ↗</a>' : '<span style="color:var(--ink-3)">No PO yet</span>') +
        (r.folder_id ? '<br><a href="https://drive.google.com/drive/folders/' + esc(r.folder_id) + '" target="_blank">Order folder ↗</a>' : '') +
      '</div>' +
    '</div>' +
    '<div class="tbl-wrap" style="margin-bottom:14px"><table class="tbl"><thead>' +
      '<tr><th>SKU</th><th>Product</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">GST</th><th class="num">Total</th></tr></thead><tbody>' +
      r.lines.map(function (l) {
        return '<tr><td>' + esc(l.sku) + '</td><td>' + esc(l.name) + '</td><td class="num">' + qty(l.qty) +
          '</td><td class="num">' + (l.list_price && l.list_price > l.unit_price ? '<span class="mrp">' + inr(l.list_price) + '</span> ' : '') +
          inr(l.unit_price) + '</td><td class="num">' + (l.gst || 0) + '%</td><td class="num">' + inr(l.line_total) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
    (r.shipments.length ? '<div class="tbl-wrap" style="margin-bottom:14px"><table class="tbl"><thead>' +
      '<tr><th>#</th><th>Date</th><th>Carrier</th><th>Tracking</th><th class="num">Qty</th><th>Status</th><th></th></tr></thead><tbody>' +
      r.shipments.map(function (s) {
        return '<tr><td>' + s.no + '</td><td>' + esc(String(s.date).slice(0, 10)) + '</td><td>' + esc(s.carrier) + '</td>' +
          '<td>' + esc(s.tracking) + '</td><td class="num">' + (s.qty || '') + '</td>' +
          '<td>' + statusPill(s.status) + '</td>' +
          '<td><button class="btn ghost small" data-shed="' + s.no + '">Edit</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '') +
    '<div class="f2"><div class="field"><label>Follow-up owner</label><select id="mOwner"><option value="' + esc(r.assigned_to || '') + '">' + esc(r.assigned_name || 'Unassigned') + '</option></select></div>' +
      '<div class="field"><label>Raised by</label><input value="' + esc(r.raised_by || '—') + '" readonly></div></div>' +
    '<div class="field"><label>Internal notes</label><textarea id="mNotes">' + esc(r.admin_notes || '') + '</textarea></div>' +
    '<div class="field"><label>Status (override)</label><select id="mStatus">' +
      STATUSES.map(function (s) { return '<option' + (s === r.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
    '</select></div>' +
    '<p class="note">Stock is held when the client accepts the PI and deducted when the purchase order lands. Overriding the status moves stock the same way.</p>' +
    '<div class="form-err" id="mErr"></div>' +
    '<button class="btn primary" id="mSave" style="width:100%;justify-content:center">Save notes / status</button>');

  if ($('oLink')) $('oLink').onclick = function () {
    try { navigator.clipboard.writeText(link); } catch (e) {}
    toast('Client link copied');
  };
  staffList().then(function (staff) {
    if (!$('mOwner')) return;
    $('mOwner').innerHTML = staffOptions(staff, r.assigned_to, 'Unassigned');
    $('mOwner').onchange = function () {
      var sel = $('mOwner');
      sel.disabled = true;
      api('adminRequestAssign', { id: r.id, assigned_to: sel.value }).then(function (res) {
        r.assigned_to = res.assigned_to; r.assigned_name = res.assigned_name;
        toast(res.assigned_name ? r.id + ' assigned to ' + res.assigned_name : r.id + ' unassigned');
        paintRequestViews();
      }).catch(function (e) { toast(e.message); }).then(function () { sel.disabled = false; });
    };
  });
  if ($('oAccept')) $('oAccept').onclick = function () { decide(r, true); };
  if ($('oReject')) $('oReject').onclick = function () { decide(r, false); };
  if ($('oQuote')) $('oQuote').onclick = function () { openQuoteBuilder(r); };
  if ($('oPiUp')) $('oPiUp').onclick = function () { uploadDoc(r, 'pi'); };
  if ($('oPoUp')) $('oPoUp').onclick = function () { uploadDoc(r, 'po'); };
  if ($('oShip')) $('oShip').onclick = function () { openShipment(r, null); };
  document.querySelectorAll('button[data-shed]').forEach(function (b) {
    b.onclick = function () {
      openShipment(r, r.shipments.filter(function (s) { return s.no === Number(b.dataset.shed); })[0]);
    };
  });
  $('mSave').onclick = function () {
    $('mSave').disabled = true;
    $('mErr').textContent = '';
    api('adminRequestUpdate', { id: r.id, status: $('mStatus').value, admin_notes: $('mNotes').value })
      .then(function () { closeDrawer(); toast(r.id + ' saved'); loadRequests(); })
      .catch(function (e) { $('mErr').textContent = e.message; $('mSave').disabled = false; });
  };
}

function decide(r, accept) {
  var note = accept ? '' : (prompt('Reason for the client (optional)') || '');
  api('adminRequestDecide', { id: r.id, accept: accept, note: note })
    .then(function (res) { closeDrawer(); toast(r.id + ' → ' + res.status); loadRequests(); })
    .catch(function (e) { toast(e.message); });
}

/* Quotation Builder — negotiated prices, freight, discount, then a GST PI PDF. */
function openQuoteBuilder(r) {
  var draft = r.lines.map(function (l) {
    return { sku: l.sku, name: l.name, qty: l.qty, unit_price: l.unit_price,
             gst: l.gst || 18, hsn: l.hsn || '', list_price: l.list_price || l.unit_price };
  });
  openDrawer(
    '<h2 style="margin:0 0 4px">Quotation for ' + esc(r.id) + '</h2>' +
    '<p class="note" style="margin:0 0 14px">Edit quantities and unit prices freely — the negotiated price replaces the catalog price on this order. The PI is generated as a PDF into the order folder and emailed to the client with Accept / Decline.</p>' +
    '<div id="qLines"></div>' +
    '<div id="qHsnWarn" class="note" style="color:var(--bad);margin:-2px 0 10px" hidden></div>' +
    '<div class="f2" style="margin-top:12px">' +
      '<div class="field"><label>Freight / handling ₹</label><input id="qFreight" type="number" min="0" value="0"></div>' +
      '<div class="field"><label>Discount ₹</label><input id="qDisc" type="number" min="0" value="0"></div>' +
      '<div class="field"><label>Validity (days)</label><input id="qDays" type="number" min="1" value="' + esc(A.settings.pi_validity_days || 15) + '"></div>' +
      '<div class="field"><label>Place of supply (GST state code)</label><input id="qPos" value="' + esc(r.place_of_supply || (r.gstin || '').slice(0, 2)) + '" placeholder="e.g. 29"></div>' +
    '</div>' +
    '<div class="field"><label>Ship to address</label><textarea id="qShip">' + esc(r.ship_address || '') + '</textarea></div>' +
    '<div class="field"><label>Notes on the PI</label><textarea id="qNotes"></textarea></div>' +
    '<div class="panel2" style="margin:12px 0"><b>Total</b> <span id="qTotal" style="float:right;font-weight:800"></span></div>' +
    '<div class="form-err" id="mErr"></div>' +
    '<div style="display:flex;gap:10px">' +
      '<button class="btn" id="qSaveOnly" style="flex:1;justify-content:center">Generate PI only</button>' +
      '<button class="btn primary" id="qSend" style="flex:1;justify-content:center">Generate &amp; send to client</button>' +
    '</div>');

  function total() {
    var t = draft.reduce(function (a, l) {
      var amt = Number(l.qty) * Number(l.unit_price);
      return a + amt + amt * Number(l.gst || 0) / 100;
    }, 0) + Number($('qFreight').value || 0) - Number($('qDisc').value || 0);
    $('qTotal').textContent = inr(Math.round(t * 100) / 100);
    // HSN is mandatory on a GST invoice — flag anything the product master could not fill.
    var missing = draft.filter(function (l) { return !String(l.hsn || '').trim(); })
                       .map(function (l) { return l.sku; });
    var w = $('qHsnWarn');
    w.hidden = !missing.length;
    w.textContent = missing.length
      ? 'No HSN code on ' + missing.join(', ') + ' — set it on the product so every future quotation fills it in.'
      : '';
  }
  function paint() {
    $('qLines').innerHTML = draft.map(function (l, i) {
      return '<div class="panel2" style="padding:12px 14px;margin-bottom:8px">' +
        '<b>' + esc(l.name) + '</b> <span style="color:var(--ink-3);font-size:12px">' + esc(l.sku) + '</span>' +
        '<div class="tier-row" style="margin-top:8px">' +
          'Qty <input type="number" min="0" data-q="' + i + '" value="' + l.qty + '" style="width:90px;padding:7px 9px;border:1px solid var(--line);border-radius:8px">' +
          ' @ ₹ <input type="number" min="0" step="0.01" data-p="' + i + '" value="' + l.unit_price + '" style="width:110px;padding:7px 9px;border:1px solid var(--line);border-radius:8px">' +
          (l.list_price && l.list_price !== l.unit_price ? '<span style="font-size:12px;color:var(--ink-3)">list ' + inr(l.list_price) + '</span>' : '') +
          ' GST <input type="number" min="0" step="0.01" data-g="' + i + '" value="' + l.gst + '" style="width:70px;padding:7px 9px;border:1px solid var(--line);border-radius:8px">%' +
          ' HSN <input data-h="' + i + '" value="' + esc(l.hsn) + '" style="width:90px;padding:7px 9px;border:1px solid var(--line);border-radius:8px">' +
          ' <button type="button" class="btn ghost small" data-x="' + i + '" style="color:var(--bad)">✕</button>' +
        '</div></div>';
    }).join('');
    $('qLines').querySelectorAll('input').forEach(function (inp) {
      inp.oninput = function () {
        var d = inp.dataset;
        var i = Number(d.q !== undefined ? d.q : d.p !== undefined ? d.p : d.g !== undefined ? d.g : d.h);
        if (d.q !== undefined) draft[i].qty = Number(inp.value);
        if (d.p !== undefined) draft[i].unit_price = Number(inp.value);
        if (d.g !== undefined) draft[i].gst = Number(inp.value);
        if (d.h !== undefined) draft[i].hsn = inp.value;
        total();
      };
    });
    $('qLines').querySelectorAll('button[data-x]').forEach(function (b) {
      b.onclick = function () { draft.splice(Number(b.dataset.x), 1); paint(); total(); };
    });
  }
  paint(); total();
  $('qFreight').oninput = total; $('qDisc').oninput = total;

  function build(send) {
    var btn = send ? $('qSend') : $('qSaveOnly');
    btn.disabled = true; btn.textContent = 'Generating…';
    api('adminPiBuild', {
      id: r.id, lines: draft, freight: Number($('qFreight').value || 0),
      discount: Number($('qDisc').value || 0), validity_days: Number($('qDays').value || 15),
      place_of_supply: $('qPos').value.trim(), ship_address: $('qShip').value,
      notes: $('qNotes').value, send: send
    }).then(function (res) {
      closeDrawer();
      toast('PI ' + res.pi_number + ' created' + (send ? ' and sent' : ''));
      loadRequests();
    }).catch(function (e) {
      $('mErr').textContent = e.message;
      btn.disabled = false; btn.textContent = send ? 'Generate & send to client' : 'Generate PI only';
    });
  }
  $('qSend').onclick = function () { build(true); };
  $('qSaveOnly').onclick = function () { build(false); };
}

function uploadDoc(r, kind) {
  var isPi = kind === 'pi';
  openDrawer(
    '<h2 style="margin:0 0 4px">Upload ' + (isPi ? 'proforma invoice' : 'purchase order') + ' — ' + esc(r.id) + '</h2>' +
    '<p class="note" style="margin:0 0 14px">' + (isPi
      ? 'Use this when the PI was produced in your own system. It is filed in the order folder and sent to the client for acceptance.'
      : 'Use this when the client sent their PO by email or any other route. Filing it here deducts the stock and confirms the order.') + '</p>' +
    '<div class="f2">' +
      '<div class="field"><label>' + (isPi ? 'PI' : 'PO') + ' number</label><input id="uNum" value="' + esc(isPi ? r.pi_number : r.po_number) + '"></div>' +
      (isPi ? '<div class="field"><label>PI total ₹</label><input id="uTotal" type="number" min="0" value="' + (r.pi_total || r.total_est || 0) + '"></div>' : '') +
    '</div>' +
    '<div class="field"><label>File (PDF)</label><input id="uFile" type="file" accept=".pdf,image/*"></div>' +
    '<div class="form-err" id="mErr"></div>' +
    '<button class="btn primary" id="uGo" style="width:100%;justify-content:center">Upload' + (isPi ? ' &amp; send' : '') + '</button>');
  $('uGo').onclick = function () {
    var f = $('uFile').files[0];
    if (!f) { $('mErr').textContent = 'Choose a file first.'; return; }
    if (f.size > 10 * 1024 * 1024) { $('mErr').textContent = 'File is over 10MB.'; return; }
    $('uGo').disabled = true; $('uGo').textContent = 'Uploading…';
    var rd = new FileReader();
    rd.onload = function () {
      var body = { id: r.id, filename: f.name, mime: f.type, data: rd.result };
      if (isPi) { body.pi_number = $('uNum').value.trim(); body.pi_total = Number($('uTotal').value || 0); }
      else { body.po_number = $('uNum').value.trim(); }
      api(isPi ? 'adminPiUpload' : 'adminPoUpload', body)
        .then(function () { closeDrawer(); toast('Uploaded'); loadRequests(); })
        .catch(function (e) { $('mErr').textContent = e.message; $('uGo').disabled = false; $('uGo').textContent = 'Upload'; });
    };
    rd.readAsDataURL(f);
  };
}

function openShipment(r, sh) {
  sh = sh || { no: 0, date: new Date().toISOString().slice(0, 10), carrier: '', tracking: '', qty: '', note: '', status: 'Dispatched' };
  openDrawer(
    '<h2 style="margin:0 0 14px">' + (sh.no ? 'Shipment ' + sh.no : 'New shipment') + ' — ' + esc(r.id) + '</h2>' +
    '<div class="f2">' +
      '<div class="field"><label>Ship date</label><input id="sDate" type="date" value="' + esc(String(sh.date).slice(0, 10)) + '"></div>' +
      '<div class="field"><label>Quantity in this shipment</label><input id="sQty" type="number" min="0" value="' + (sh.qty || '') + '"></div>' +
      '<div class="field"><label>Carrier</label><input id="sCarrier" value="' + esc(sh.carrier) + '"></div>' +
      '<div class="field"><label>Tracking number</label><input id="sTrack" value="' + esc(sh.tracking) + '"></div>' +
    '</div>' +
    '<div class="field"><label>Note</label><input id="sNote" value="' + esc(sh.note) + '"></div>' +
    '<div class="field"><label>Status</label><select id="sStatus">' +
      '<option' + (sh.status === 'Dispatched' ? ' selected' : '') + '>Dispatched</option>' +
      '<option' + (sh.status === 'Delivered' ? ' selected' : '') + '>Delivered</option>' +
    '</select></div>' +
    '<p class="note">The client is emailed the tracking details. When every shipment is marked delivered the order moves to Delivered.</p>' +
    '<div class="form-err" id="mErr"></div>' +
    '<div style="display:flex;gap:10px">' +
      (sh.no ? '<button class="btn danger" id="sDel">Delete</button>' : '') +
      '<button class="btn primary" id="sSave" style="flex:1;justify-content:center">Save shipment</button></div>');
  $('sSave').onclick = function () {
    $('sSave').disabled = true;
    api('adminShipmentSave', { id: r.id, shipment: {
      shipment_no: sh.no, ship_date: $('sDate').value, qty: Number($('sQty').value || 0),
      carrier: $('sCarrier').value.trim(), tracking: $('sTrack').value.trim(),
      note: $('sNote').value.trim(), status: $('sStatus').value
    } }).then(function () { closeDrawer(); toast('Shipment saved'); loadRequests(); })
      .catch(function (e) { $('mErr').textContent = e.message; $('sSave').disabled = false; });
  };
  if ($('sDel')) $('sDel').onclick = function () {
    api('adminShipmentDelete', { id: r.id, shipment_no: sh.no })
      .then(function () { closeDrawer(); toast('Shipment removed'); loadRequests(); })
      .catch(function (e) { $('mErr').textContent = e.message; });
  };
}

/* ================= CATALOG + BRANDS ================= */
function loadCatalog() {
  A.loaded.catalog = A.loaded.brands = true;
  $('p-catalog').innerHTML = '<div class="spin"></div>';
  $('p-brands').innerHTML = '<div class="spin"></div>';
  return api('adminCatalog').then(function (res) {
    A.products = res.products;
    A.brands = res.brands;
    renderCatalog();
    renderBrands();
  }).catch(function (e) {
    $('p-catalog').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  });
}

function renderCatalog() {
  var lowCount = A.products.filter(function (p) { return p.atp <= p.reorder_point; }).length;
  $('p-catalog').innerHTML =
    '<div class="stat-row">' +
      stat(A.products.length, 'Products') +
      stat(A.products.filter(function (p) { return p.visible; }).length, 'Published') +
      stat(lowCount, 'At / below reorder point') +
    '</div>' +
    '<div class="panel-head"><h2>Catalog</h2><span class="sp"></span>' +
      '<button class="btn small" id="cExport">Export CSV</button>' +
      '<button class="btn primary small" id="cNew">+ Product</button></div>' +
    filterBar('cat', [
      { key: 'brand', label: 'Brand', options: A.brands.map(function (b) { return [b.id, b.name]; }) },
      { key: 'category', label: 'Category', options: uniq(A.products.map(function (p) { return p.category; })).map(function (c) { return [c, c]; }) },
      { key: 'stock', label: 'Stock', options: [['in', 'In stock'], ['low', 'At / below reorder point'], ['out', 'Out of stock']] },
      { key: 'visible', label: 'Visibility', options: [['yes', 'Published'], ['no', 'Hidden']] }
    ], 'search SKU, name, HSN') +
    '<div class="note" id="cCount" style="margin:-4px 0 8px"></div>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th></th><th>SKU</th><th>Product</th><th>Brand</th><th class="num">MOQ</th><th class="num">MRP</th><th class="num">From</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">ATP</th><th>Visible</th>' +
    '</tr></thead><tbody id="cRows"></tbody></table></div>';
  $('cNew').onclick = function () { editProduct(null); };
  $('cExport').onclick = exportProducts;
  wireFilterBar('cat', function (typing) { if (typing) paintCatalogRows(); else renderCatalog(); });
  paintCatalogRows();
}

function paintCatalogRows() {
  var st = filterState('cat'), q = (st.q || '').toLowerCase();
  var tb = $('cRows');
  tb.innerHTML = '';
  var shown = A.products.filter(function (p) {
    if (st.brand && p.brand_id !== st.brand) return false;
    if (st.category && p.category !== st.category) return false;
    if (st.visible === 'yes' && !p.visible) return false;
    if (st.visible === 'no' && p.visible) return false;
    if (st.stock === 'out' && p.atp > 0) return false;
    if (st.stock === 'low' && !(p.atp <= p.reorder_point)) return false;
    if (st.stock === 'in' && !(p.atp > 0 && p.atp > p.reorder_point)) return false;
    return !q || (p.sku + ' ' + p.name + ' ' + p.hsn + ' ' + brandName(p.brand_id) + ' ' + p.category).toLowerCase().indexOf(q) >= 0;
  });
  $('cCount').textContent = shown.length === A.products.length ? A.products.length + ' products' : shown.length + ' of ' + A.products.length + ' products';
  if (!shown.length) tb.innerHTML = '<tr><td colspan="11"><div class="empty" style="padding:26px 0">No product matches these filters.</div></td></tr>';
  shown.forEach(function (p) {
    var low = p.atp <= p.reorder_point;
    var from = p.tiers.length ? p.tiers[p.tiers.length - 1].price : 0;
    var tr = document.createElement('tr');
    tr.className = 'click';
    tr.innerHTML =
      '<td>' + (p.images[0] ? '<img class="prod-img" style="width:38px;height:38px" src="' + esc(p.images[0]) + '">' : '') + '</td>' +
      '<td>' + esc(p.sku) + '</td>' +
      '<td><b>' + esc(p.name) + '</b><br><small style="color:var(--ink-3)">' + esc(p.category) + '</small></td>' +
      '<td>' + esc(brandName(p.brand_id)) + '</td><td class="num">' + p.moq + '</td>' +
      '<td class="num" style="text-decoration:line-through;color:var(--ink-3)">' + (p.mrp ? inr(p.mrp) : '—') + '</td>' +
      '<td class="num">' + (from ? inr(from) : '—') + '</td>' +
      '<td class="num">' + qty(p.on_hand) + '</td><td class="num">' + qty(p.reserved) + '</td>' +
      '<td class="num" style="font-weight:800;color:' + (low ? 'var(--bad)' : 'inherit') + '">' + qty(p.atp) + (low ? ' ⚠' : '') + '</td>' +
      '<td>' + (p.visible ? '✓' : '—') + '</td>';
    tr.onclick = function () { editProduct(p); };
    tb.appendChild(tr);
  });
}

/* Product editor — RSM-style tier rows: min qty @ price, per-tier GST (blank inherits) */
function editProduct(p) {
  var isNew = !p;
  p = p || { sku: '', name: '', brand_id: '', category: '', subcategory: '', description: '', specs: '',
             images: [], moq: 1, gst_rate: 18, hsn: '', mrp: '', lead_time: '', on_hand: 0, reserved: 0,
             safety_stock: 0, reorder_point: 0, visible: true, show_price: true,
             tiers: [{ min: 1, price: 0, gst: '' }] };
  var draft = JSON.parse(JSON.stringify(p));
  if (!draft.tiers.length) draft.tiers = [{ min: draft.moq || 1, price: 0, gst: '' }];

  openDrawer(
    '<h2 style="margin:0 0 14px">' + (isNew ? 'New product' : esc(p.sku)) + '</h2>' +
    '<div class="f2">' +
      '<div class="field"><label>SKU *</label><input id="eSku" value="' + esc(p.sku) + '"' + (isNew ? '' : ' readonly') + '></div>' +
      '<div class="field"><label>Brand</label><select id="eBrand"><option value="">—</option>' +
        A.brands.map(function (b) { return '<option value="' + esc(b.id) + '"' + (b.id === p.brand_id ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('') +
      '</select></div>' +
    '</div>' +
    '<div class="field"><label>Name *</label><input id="eName" value="' + esc(p.name) + '"></div>' +
    '<div class="f2">' +
      '<div class="field"><label>Category</label><input id="eCat" value="' + esc(p.category) + '"></div>' +
      '<div class="field"><label>Subcategory</label><input id="eSub" value="' + esc(p.subcategory) + '"></div>' +
    '</div>' +
    '<div class="field"><label>Description</label><textarea id="eDesc">' + esc(p.description) + '</textarea></div>' +
    '<div class="field"><label>Specs (one per line, "Key: value")</label><textarea id="eSpecs">' +
      esc(String(p.specs || '').split('|').join('\n')) + '</textarea></div>' +
    '<div class="field"><label>Images</label>' +
      '<div id="eImgs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"></div>' +
      '<input id="eFile" type="file" accept="image/*" multiple></div>' +
    '<div class="f2">' +
      '<div class="field"><label>MOQ (1 = no minimum)</label><input id="eMoq" type="number" min="1" value="' + draft.moq + '"></div>' +
      '<div class="field"><label>Product GST %</label><input id="eGst" type="number" min="0" step="0.01" value="' + draft.gst_rate + '"></div>' +
      '<div class="field"><label>HSN code</label><input id="eHsn" value="' + esc(p.hsn || '') + '" placeholder="e.g. 9617" maxlength="8"></div>' +
      '<div class="field"><label>MRP ₹ (shown struck through)</label><input id="eMrp" type="number" min="0" value="' + (p.mrp || '') + '"></div>' +
      '<div class="field"><label>Lead time</label><input id="eLead" value="' + esc(p.lead_time) + '"></div>' +
      '<div class="field"><label>On hand</label><input id="eOnHand" type="number" value="' + p.on_hand + '"></div>' +
      '<div class="field"><label>Safety stock</label><input id="eSafety" type="number" value="' + p.safety_stock + '"></div>' +
      '<div class="field"><label>Reorder point</label><input id="eReorder" type="number" value="' + p.reorder_point + '"></div>' +
    '</div>' +
    (isNew ? '' : '<p class="note">Reserved: ' + p.reserved + ' (owned by the request lifecycle) · ATP: ' + p.atp + '</p>') +
    '<h3 style="margin:16px 0 4px">Price tiers</h3>' +
    '<p class="note" style="margin:0 0 10px">The first tier must start at the MOQ. GST left blank uses the product rate — set it per tier only when volume crosses a slab.</p>' +
    '<div id="tierBox"></div>' +
    '<div class="f2" style="margin-top:12px">' +
      '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:14px"><input id="eVisible" type="checkbox"' + (p.visible ? ' checked' : '') + '> Active in the catalogue</label>' +
      '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:14px"><input id="eShowPrice" type="checkbox"' + (p.show_price ? ' checked' : '') + '> Show prices</label>' +
    '</div>' +
    '<div class="form-err" id="mErr"></div>' +
    '<div style="display:flex;gap:10px;margin-top:6px">' +
      (isNew ? '' : '<button class="btn danger" id="eHide">Hide from store</button>') +
      '<button class="btn primary" id="eSave" style="flex:1;justify-content:center">Save product</button>' +
    '</div>');

  function paintTiers() {
    var box = $('tierBox');
    box.innerHTML = '';
    draft.tiers.forEach(function (t, i) {
      var row = document.createElement('div');
      row.className = 'tier-row';
      row.innerHTML =
        'From <input type="number" min="1" style="width:90px" data-k="min" data-i="' + i + '" value="' + t.min + '"> units' +
        ' @ ₹ <input type="number" min="0" step="0.01" style="width:110px" data-k="price" data-i="' + i + '" value="' + t.price + '">' +
        ' GST <input type="number" min="0" step="0.01" style="width:70px" placeholder="' + draft.gst_rate + '" title="Leave blank to use the product rate" data-k="gst" data-i="' + i + '" value="' + (t.gst === '' || t.gst === null || t.gst === undefined ? '' : t.gst) + '"> %' +
        ' <button type="button" class="btn ghost small" data-rm="' + i + '">Remove</button>';
      box.appendChild(row);
    });
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn small';
    add.textContent = '+ Add tier';
    add.onclick = function () {
      var last = draft.tiers[draft.tiers.length - 1];
      draft.tiers.push({ min: last ? Number(last.min) * 2 : (Number($('eMoq').value) || 1),
                         price: last ? last.price : 0, gst: last ? last.gst : '' });
      paintTiers();
    };
    box.appendChild(add);
    box.querySelectorAll('input[data-k]').forEach(function (inp) {
      inp.oninput = function () {
        var t = draft.tiers[Number(inp.dataset.i)];
        t[inp.dataset.k] = inp.value === '' ? '' : Number(inp.value);
      };
    });
    box.querySelectorAll('button[data-rm]').forEach(function (b) {
      b.onclick = function () { draft.tiers.splice(Number(b.dataset.rm), 1); paintTiers(); };
    });
  }
  paintTiers();

  var images = p.images.slice();
  function paintImgs() {
    $('eImgs').innerHTML = images.map(function (u, i) {
      return '<span style="position:relative"><img src="' + esc(u) + '" style="width:64px;height:64px;object-fit:contain;background:var(--bg);border-radius:8px;border:1px solid var(--line)">' +
        '<button data-i="' + i + '" style="position:absolute;top:-6px;right:-6px;border:none;background:var(--bad);color:#fff;border-radius:999px;width:20px;height:20px;font-size:11px;cursor:pointer">✕</button></span>';
    }).join('');
    $('eImgs').querySelectorAll('button').forEach(function (b) {
      b.onclick = function () { images.splice(Number(b.dataset.i), 1); paintImgs(); };
    });
  }
  paintImgs();
  $('eFile').onchange = function () {
    Array.prototype.slice.call(this.files).forEach(function (f) {
      if (f.size > 4 * 1024 * 1024) { $('mErr').textContent = f.name + ' is over 4MB'; return; }
      var rd = new FileReader();
      rd.onload = function () {
        $('mErr').textContent = 'Uploading ' + f.name + '…';
        api('adminImageUpload', { data: rd.result, filename: f.name, mime: f.type })
          .then(function (res) { images.push(res.url); paintImgs(); $('mErr').textContent = ''; })
          .catch(function (e) { $('mErr').textContent = e.message; });
      };
      rd.readAsDataURL(f);
    });
  };

  if (!isNew) {
    $('eHide').onclick = function () {
      api('adminProductDelete', { sku: p.sku })
        .then(function () { closeDrawer(); toast('Hidden'); loadCatalog(); })
        .catch(function (e) { $('mErr').textContent = e.message; });
    };
  }
  $('eSave').onclick = function () {
    var tiers = draft.tiers.filter(function (t) { return Number(t.min) > 0 && Number(t.price) >= 0; })
      .map(function (t) { return { min: Number(t.min), price: Number(t.price), gst: t.gst === '' ? '' : Number(t.gst) }; })
      .sort(function (a, b) { return a.min - b.min; });
    var moq = Number($('eMoq').value) || 1;
    if (tiers.length && tiers[0].min !== moq) {
      $('mErr').textContent = 'The first tier must start at the MOQ (' + moq + ').';
      return;
    }
    var payload = {
      sku: $('eSku').value.trim(), name: $('eName').value.trim(),
      brand_id: $('eBrand').value, category: $('eCat').value.trim(), subcategory: $('eSub').value.trim(),
      description: $('eDesc').value.trim(),
      specs: $('eSpecs').value.split('\n').map(function (s) { return s.trim(); }).filter(String).join('|'),
      images: images,
      moq: moq, gst_rate: Number($('eGst').value), hsn: $('eHsn').value.trim(),
      mrp: Number($('eMrp').value) || '', lead_time: $('eLead').value.trim(),
      on_hand: Number($('eOnHand').value), safety_stock: Number($('eSafety').value),
      reorder_point: Number($('eReorder').value),
      visible: $('eVisible').checked, show_price: $('eShowPrice').checked,
      tiers: tiers
    };
    if (!payload.sku || !payload.name) { $('mErr').textContent = 'SKU and name are required.'; return; }
    $('eSave').disabled = true;
    api('adminProductSave', { product: payload })
      .then(function () { closeDrawer(); toast(payload.sku + ' saved'); loadCatalog(); })
      .catch(function (e) { $('mErr').textContent = e.message; $('eSave').disabled = false; });
  };
}

function exportProducts() {
  api('adminExportCsv', { tab: 'Products' }).then(function (res) {
    var a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(res.csv);
    a.download = res.filename;
    a.click();
  }).catch(function (e) { toast(e.message); });
}

/* ================= BRANDS ================= */
function renderBrands() {
  $('p-brands').innerHTML =
    '<div class="panel-head"><h2>Brands</h2><span class="sp"></span>' +
      '<button class="btn primary small" id="bNew">+ Brand</button></div>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>Logo</th><th>Name</th><th class="num">Products</th><th>Active</th><th class="num">Sort</th>' +
    '</tr></thead><tbody id="bRows"></tbody></table></div>';
  $('bNew').onclick = function () { editBrand(null); };
  var tb = $('bRows');
  A.brands.sort(function (a, b) { return a.sort - b.sort; }).forEach(function (b) {
    var count = A.products.filter(function (p) { return p.brand_id === b.id; }).length;
    var tr = document.createElement('tr');
    tr.className = 'click';
    tr.innerHTML =
      '<td>' + (b.logo ? '<span class="brand-thumb"><img src="' + esc(b.logo) + '" alt=""></span>' :
        '<span class="brand-thumb no-logo">' + esc(b.name.charAt(0)) + '</span>') + '</td>' +
      '<td><b>' + esc(b.name) + '</b><br><small style="color:var(--ink-3)">' + esc(b.desc || '') + '</small></td>' +
      '<td class="num">' + count + '</td><td>' + (b.active ? '✓' : '—') + '</td><td class="num">' + b.sort + '</td>';
    tr.onclick = function () { editBrand(b); };
    tb.appendChild(tr);
  });
}

function editBrand(b) {
  var isNew = !b;
  b = b || { id: '', name: '', logo: '', desc: '', active: true, sort: A.brands.length + 1 };
  openDrawer(
    '<h2 style="margin:0 0 14px">' + (isNew ? 'New brand' : esc(b.name)) + '</h2>' +
    '<div class="field"><label>Name *</label><input id="bName" value="' + esc(b.name) + '"></div>' +
    '<div class="field"><label>Description</label><input id="bDesc" value="' + esc(b.desc) + '"></div>' +
    '<div class="field"><label>Logo</label>' +
      '<div class="logo-picker">' +
        '<div id="bLogoPrev" class="logo-prev"></div>' +
        '<div class="logo-picker-side">' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<label class="btn small" id="bPick" for="bFile" style="cursor:pointer">Choose image</label>' +
            '<button type="button" class="btn small" id="bClear" hidden>Remove</button>' +
          '</div>' +
          '<div id="bLogoName" class="note logo-name"></div>' +
        '</div>' +
      '</div>' +
      '<input id="bFile" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" class="sr-only"></div>' +
    '<div class="f2">' +
      '<div class="field"><label>Sort order</label><input id="bSort" type="number" value="' + b.sort + '"></div>' +
      '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:14px;margin-top:20px"><input id="bActive" type="checkbox"' + (b.active ? ' checked' : '') + '> Active</label>' +
    '</div>' +
    '<div class="form-err" id="mErr"></div>' +
    '<div style="display:flex;gap:10px">' +
      (isNew ? '' : '<button class="btn danger" id="bDel">Delete</button>') +
      '<button class="btn primary" id="bSave" style="flex:1;justify-content:center">Save brand</button>' +
    '</div>');
  var logo = b.logo, logoName = b.logo ? 'Saved logo' : '', uploading = false;

  // The picker always states what the brand is carrying right now: the live
  // image, or an explicit empty state — never a bare "no file chosen".
  function paintLogo() {
    $('bLogoPrev').innerHTML = logo
      ? '<img src="' + esc(logo) + '" alt="">'
      : '<span class="logo-none">No logo</span>';
    $('bLogoPrev').className = 'logo-prev' + (logo ? '' : ' no-logo');
    $('bPick').textContent = logo ? 'Replace image' : 'Choose image';
    $('bClear').hidden = !logo;
    $('bLogoName').textContent = logo
      ? logoName
      : 'No logo set — the chip falls back to the brand name. PNG or SVG on a transparent background works best.';
  }
  paintLogo();

  $('bClear').onclick = function () {
    logo = ''; logoName = '';
    paintLogo();
    $('mErr').textContent = 'Logo removed — press Save brand to apply it.';
  };

  $('bFile').onchange = function () {
    var f = this.files[0];
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) {
      this.value = '';
      $('mErr').textContent = 'That file is ' + (f.size / 1048576).toFixed(1) +
        'MB — the limit is 4MB. Export it smaller and try again.';
      paintLogo();
      return;
    }
    var rd = new FileReader();
    rd.onerror = function () {
      $('mErr').textContent = 'Could not read that file from disk.';
      paintLogo();
    };
    rd.onload = function () {
      // The upload only puts the file in Drive — the URL reaches the Brands row
      // when Save is pressed, so block Save until we actually hold that URL.
      uploading = true;
      $('bSave').disabled = true;
      $('bLogoName').textContent = 'Uploading ' + f.name + '…';
      $('mErr').textContent = '';
      api('adminImageUpload', { data: rd.result, filename: 'brand-' + f.name, mime: f.type })
        .then(function (res) {
          logo = res.url;
          logoName = f.name;
          uploading = false;
          $('bSave').disabled = false;
          paintLogo();
          $('mErr').textContent = 'Logo uploaded — press Save brand to keep it.';
        })
        .catch(function (e) {
          uploading = false;
          $('bSave').disabled = false;
          paintLogo();
          $('mErr').textContent = e.message;
        });
    };
    rd.readAsDataURL(f);
  };
  if (!isNew) {
    $('bDel').onclick = function () {
      api('adminBrandDelete', { id: b.id })
        .then(function () { closeDrawer(); toast('Deleted'); loadCatalog(); })
        .catch(function (e) { $('mErr').textContent = e.message; });
    };
  }
  $('bSave').onclick = function () {
    if (uploading) { $('mErr').textContent = 'Logo is still uploading — one moment.'; return; }
    api('adminBrandSave', { brand: { id: b.id, name: $('bName').value.trim(), desc: $('bDesc').value.trim(), logo: logo, sort: Number($('bSort').value), active: $('bActive').checked } })
      .then(function () { closeDrawer(); toast('Brand saved'); loadCatalog(); })
      .catch(function (e) { $('mErr').textContent = e.message; });
  };
}

/* ================= STAFF-RAISED REQUEST ================= */

/** Who is at the keyboard. Remembered per browser until staff accounts exist. */
/* ---------- product picker: search with thumbnails ---------- */
function thumb(p, size) {
  size = size || 40;
  var src = p && p.images && p.images[0];
  return src ? '<img class="pthumb" src="' + esc(src) + '" alt="" style="width:' + size + 'px;height:' + size + 'px" loading="lazy">'
             : '<span class="pthumb no-img" style="width:' + size + 'px;height:' + size + 'px"></span>';
}
/**
 * Turns a text input into a product search. Typing filters by SKU, name, brand or
 * category; each row shows the image so the right variant is easy to confirm.
 * Picking writes the SKU into the input and calls onPick(product).
 */
function attachProductPicker(input, panel, products, onPick) {
  var idx = -1, shown = [];
  function rows() {
    var q = input.value.trim().toLowerCase();
    var list = products.filter(function (p) {
      if (!q) return true;
      return [p.sku, p.name, brandName(p.brand_id), p.category || ''].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    // exact SKU first, then prefix matches, then the rest
    list.sort(function (a, b) {
      function rank(p) { var s = p.sku.toLowerCase(), n = p.name.toLowerCase(); return s === q ? 0 : s.indexOf(q) === 0 ? 1 : n.indexOf(q) === 0 ? 2 : 3; }
      return q ? rank(a) - rank(b) : 0;
    });
    return list.slice(0, 40);
  }
  function paint() {
    shown = rows(); idx = -1;
    panel.innerHTML = shown.length ? shown.map(function (p, i) {
      var stock = p.atp <= 0 ? '<span class="badge out">out</span>' : '<span style="color:var(--ink-3)">' + qty(p.atp) + ' available</span>';
      return '<div class="ppick-row" data-i="' + i + '">' + thumb(p, 44) +
        '<div class="ppick-txt"><b>' + esc(p.name) + '</b><small>' + esc(p.sku) + ' · ' + esc(brandName(p.brand_id) || '') + ' · MOQ ' + p.moq + ' · ' + stock + '</small></div></div>';
    }).join('') : '<div class="ppick-none">No product matches</div>';
    panel.hidden = false;
    panel.querySelectorAll('.ppick-row').forEach(function (r) {
      r.onmousedown = function (e) { e.preventDefault(); pick(shown[Number(r.dataset.i)]); };
    });
  }
  function pick(p) {
    if (!p) return;
    input.value = p.sku; panel.hidden = true;
    if (onPick) onPick(p);
  }
  function move(d) {
    var items = panel.querySelectorAll('.ppick-row');
    if (!items.length) return;
    idx = (idx + d + items.length) % items.length;
    items.forEach(function (el, i) { el.classList.toggle('on', i === idx); });
    items[idx].scrollIntoView({ block: 'nearest' });
  }
  input.addEventListener('focus', paint);
  input.addEventListener('input', paint);
  input.addEventListener('blur', function () { setTimeout(function () { panel.hidden = true; }, 120); });
  input.addEventListener('keydown', function (e) {
    if (panel.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { paint(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      var p = idx >= 0 ? shown[idx] : (shown.length === 1 ? shown[0] : shown.filter(function (x) { return x.sku.toLowerCase() === input.value.trim().toLowerCase(); })[0]);
      if (p) pick(p);
    } else if (e.key === 'Escape') { if (!panel.hidden) { panel.hidden = true; e.stopPropagation(); } }
  });
}

function actorName() {
  try { return localStorage.getItem('mf_actor') || ''; } catch (e) { return ''; }
}
function rememberActor(name) {
  try { localStorage.setItem('mf_actor', name); } catch (e) {}
}

/** Same rule the backend applies: highest tier whose minimum the quantity reaches. */
function tierPrice(p, qty) {
  var price = 0;
  (p.tiers || []).slice().sort(function (a, b) { return a.min - b.min; })
    .forEach(function (t) { if (qty >= t.min) price = t.price; });
  return price;
}

function newRequest(presetCompany, presetProduct) {
  var need = [staffList()];
  if (!A.products.length) need.push(api('adminCatalog').then(function (res) { A.products = res.products; A.brands = res.brands; }));
  if (!A.companies.length && !A.loaded.accounts) need.push(api('adminCompanies').then(function (res) {
    A.companies = res.companies; A.contacts = res.contacts;
  }).catch(function () { /* tabs may not exist yet; free-text company still works */ }));
  Promise.all(need).then(function (r) { openNewRequest(r[0] || [], presetCompany, presetProduct); });
}

function openNewRequest(staff, presetCompany, presetProduct) {
  var lines = [];          // {sku, qty}
  var companyId = '';
  var me = A.user || {};

  var catalogue = A.products.filter(function (p) { return p.visible; });
  var companies = A.companies.filter(function (c) { return c.active; });

  goTab('enquiries');
  A.loaded.enquiries = true;
  closeDrawer();
  $('p-enquiries').innerHTML =
    '<div style="margin-bottom:10px"><a href="#" id="nBack" style="font-weight:700">← Enquiries</a></div>' +
    '<div class="panel-head"><h2 style="margin:0">New enquiry</h2><span class="sp"></span>' +
      '<button class="btn small" id="nCancel">Cancel</button><button class="btn primary small" id="nSaveTop" style="margin-left:8px">Raise enquiry</button></div>' +
    '<p class="note" style="margin-top:-6px">Raised on the customer\'s behalf. It enters the flow at <b>New</b>: accept it, build the quotation, the PI goes out with the client link, and the purchase order turns it into an order.</p>' +
    '<div class="enq-page">' +
      '<div>' +
        '<div class="card-block" style="margin-bottom:16px"><h3>Customer</h3>' +
          pickerField('nCompany', 'Account *', 'pick an account, or type a new name') +
          '<div class="note" id="nCompanyHint" style="margin:-8px 0 10px"></div>' +
          '<div class="f2">' +
            pickerField('nContact', 'Contact name *', 'pick a contact, or type a name') +
            '<div class="field"><label>Contact email *</label><input id="nEmail" type="email"></div>' +
            '<div class="field"><label>Phone</label><input id="nPhone"></div>' +
            '<div class="field"><label>GSTIN</label><input id="nGstin" maxlength="15"></div>' +
            '<div class="field"><label>Ship-to address</label><input id="nShip"></div>' +
            '<div class="field"><label>Place of supply</label><select id="nPos">' + stateOptions('', 'Choose a state') + '</select></div>' +
          '</div></div>' +
        '<div class="card-block"><h3>Lines</h3>' +
          '<p class="note-sub" style="margin:-6px 0 10px">Price is the tier the quantity reaches. Change it later in the quotation builder, not here.</p>' +
          '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:10px">' +
            '<div class="field" style="flex:1;margin:0"><label>Product</label>' +
              '<div class="ppick-wrap"><input id="nSku" placeholder="type a SKU, name, brand or category" autocomplete="off"></div></div>' +
            '<div class="field" style="width:110px;margin:0"><label>Qty</label><input id="nQty" type="number" min="1"></div>' +
            '<button class="btn small" id="nAdd" style="height:40px">Add</button>' +
          '</div>' +
          '<div class="ppick inline" id="nSkuPick" hidden></div>' +
          '<div id="nLines"></div></div>' +
      '</div>' +
      '<div><div class="card-block enq-side">' +
        '<h3>Enquiry</h3>' +
        '<div class="field"><label>Raised by *</label><input id="nActor" value="' + esc(A.user ? A.user.name : actorName()) + '"' + (A.user ? ' readonly' : '') + ' placeholder="your name — goes on the enquiry and the audit log"></div>' +
        '<div class="field"><label>Follow-up owner</label><select id="nOwner">' + staffOptions(staff, me.email || '', 'Unassigned') + '</select></div>' +
        '<div class="field"><label>Notes</label><textarea id="nNotes" placeholder="anything the quotation builder should know" style="min-height:70px"></textarea></div>' +
        '<div id="nSummary" class="note" style="margin:0 0 10px"></div>' +
        '<div class="form-err" id="mErr"></div>' +
        '<button class="btn primary" id="nSave" style="width:100%;justify-content:center">Raise enquiry</button>' +
      '</div></div>' +
    '</div>';
  $('nBack').onclick = function (ev) { ev.preventDefault(); renderEnquiries(); };
  $('nCancel').onclick = function () { renderEnquiries(); };
  $('nSaveTop').onclick = function () { $('nSave').click(); };

  function findCompany(name) {
    var k = String(name || '').trim().toLowerCase();
    return companies.filter(function (c) { return String(c.name).trim().toLowerCase() === k; })[0] || null;
  }
  function findProduct(sku) {
    var k = String(sku || '').trim().toUpperCase();
    return catalogue.filter(function (p) { return String(p.sku).toUpperCase() === k; })[0] || null;
  }

  // Choosing a known account fills what we already hold about it.
  function applyCompany(c) {
    companyId = c ? c.id : '';
    $('nCompanyHint').textContent = c
      ? 'Existing account ' + c.id + (c.orders ? ' · ' + c.orders + ' previous enquir' + (c.orders === 1 ? 'y' : 'ies') : '') + (c.owner ? ' · owner ' + c.owner : '')
      : ($('nCompany').value.trim() ? 'New account — it will be created from this enquiry on the next import.' : '');
    if (!c) return;
    if (c.gstin && !$('nGstin').value) $('nGstin').value = c.gstin;
    if (!$('nShip').value) $('nShip').value = c.ship_address || '';
    if (c.state_code && !$('nPos').value) $('nPos').value = c.state_code;
    if (c.phone && !$('nPhone').value) $('nPhone').value = c.phone;
    if (c.owner_email && staff.some(function (u) { return u.email === c.owner_email; }) && !me.email) $('nOwner').value = c.owner_email;
    var people = contactsOf(c.id);
    if (people.length === 1) applyContact(people[0]);
  }
  function applyContact(ct) {
    $('nContact').value = ct.name || ct.email || '';
    if (ct.email) $('nEmail').value = ct.email;
    if (ct.phone && !$('nPhone').value) $('nPhone').value = ct.phone;
  }
  attachPicker($('nCompany'), $('nCompanyPick'), companies, {
    text: function (c) { return c.name; },
    sub: function (c) { return [c.id, c.gstin, c.bill && c.bill.city, c.owner].filter(String).join(' · '); },
    free: true, empty: 'No account with that name',
    onPick: applyCompany,
    onType: function (v) { applyCompany(findCompany(v)); }
  });
  attachPicker($('nContact'), $('nContactPick'), function () { return companyId ? contactsOf(companyId) : []; }, {
    text: function (ct) { return ct.name || ct.email; },
    sub: function (ct) { return [ct.email, ct.phone, ct.role].filter(String).join(' · '); },
    free: true, empty: companyId ? 'No contact on this account with that name' : 'Pick an account first',
    onPick: applyContact
  });
  if (presetCompany) { $('nCompany').value = presetCompany.name; applyCompany(presetCompany); }
  if (presetProduct) lines.push({ sku: presetProduct.sku, qty: presetProduct.moq || 1 });

  function paintLines() {
    if (!lines.length) {
      $('nLines').innerHTML = '<div class="empty" style="padding:14px 0">No lines yet. Search a product above and add it.</div>';
      $('nSummary').textContent = 'No lines yet.';
      return;
    }
    var total = 0;
    $('nLines').innerHTML =
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>SKU</th><th>Product</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Line</th><th>Stock</th><th></th>' +
      '</tr></thead><tbody>' +
      lines.map(function (l, i) {
        var p = findProduct(l.sku);
        var unit = p ? tierPrice(p, l.qty) : 0;
        var lt = unit * l.qty; total += lt;
        var stock = !p ? '' : l.qty > p.atp
          ? '<span style="color:var(--bad);font-weight:700">short by ' + qty(l.qty - p.atp) + '</span>'
          : '<span style="color:var(--ink-3)">' + qty(p.atp) + ' available</span>';
        return '<tr><td>' + thumb(p) + '</td><td><b>' + esc(l.sku) + '</b><br><small style="color:var(--ink-3)">' + esc(p ? p.name : '?') + '</small></td>' +
          '<td class="num"><input type="number" min="1" value="' + l.qty + '" data-i="' + i + '" style="width:80px;text-align:right"></td>' +
          '<td class="num">' + inr(unit) + '</td><td class="num">' + inr(lt) + '</td>' +
          '<td>' + stock + '</td>' +
          '<td class="num"><button class="btn small" data-x="' + i + '">×</button></td></tr>';
      }).join('') +
      '</tbody><tfoot><tr><td colspan="4" style="text-align:right;font-weight:700">Estimated total</td>' +
      '<td class="num"><b>' + inr(total) + '</b></td><td colspan="2"></td></tr></tfoot></table></div>';

    $('nSummary').innerHTML = '<b>' + lines.length + ' line' + (lines.length === 1 ? '' : 's') + '</b> · ' + qty(lines.reduce(function (s, l) { return s + l.qty; }, 0)) + ' units · estimated <b>' + inr(total) + '</b> ex-GST';
    $('nLines').querySelectorAll('input[data-i]').forEach(function (inp) {
      inp.onchange = function () {
        var i = Number(inp.dataset.i), p = findProduct(lines[i].sku), v = Math.floor(Number(inp.value) || 0);
        if (p && v < p.moq) { $('mErr').textContent = p.name + ': minimum order is ' + p.moq; v = p.moq; }
        else $('mErr').textContent = '';
        lines[i].qty = Math.max(1, v);
        paintLines();
      };
    });
    $('nLines').querySelectorAll('button[data-x]').forEach(function (b) {
      b.onclick = function () { lines.splice(Number(b.dataset.x), 1); paintLines(); };
    });
  }
  paintLines();

  attachProductPicker($('nSku'), $('nSkuPick'), catalogue, function (p) {
    if (!$('nQty').value) $('nQty').value = p.moq;
    $('nQty').focus();
  });
  $('nAdd').onclick = function () {
    var p = findProduct($('nSku').value);
    if (!p) { $('mErr').textContent = 'Pick a product from the list.'; return; }
    var q = Math.floor(Number($('nQty').value) || 0);
    if (q < p.moq) { $('mErr').textContent = p.name + ': minimum order is ' + p.moq; return; }
    var existing = lines.filter(function (l) { return l.sku === p.sku; })[0];
    if (existing) existing.qty += q; else lines.push({ sku: p.sku, qty: q });
    $('nSku').value = ''; $('nQty').value = ''; $('mErr').textContent = '';
    paintLines();
    $('nSku').focus();
  };

  $('nSave').onclick = function () {
    var actor = $('nActor').value.trim();
    var company = $('nCompany').value.trim();
    var contact = $('nContact').value.trim();
    var email = $('nEmail').value.trim();
    if (!actor) { $('mErr').textContent = 'Put your name in Raised by.'; return; }
    if (!company || !contact || !email) { $('mErr').textContent = 'Company, contact and email are required.'; return; }
    if (!lines.length) { $('mErr').textContent = 'Add at least one line.'; return; }
    var gstin = $('nGstin').value.trim().toUpperCase();
    if (gstin && gstin.length !== 15) { $('mErr').textContent = 'A GSTIN is 15 characters.'; return; }

    var c = findCompany(company);
    rememberActor(actor);
    $('nSave').disabled = true; $('nSaveTop').disabled = true;
    $('mErr').textContent = '';
    api('adminRequestCreate', {
      actor: actor, company_id: c ? c.id : '',
      company: company, contact: contact, email: email,
      phone: $('nPhone').value.trim(), gstin: gstin, notes: $('nNotes').value.trim(),
      ship_address: $('nShip').value.trim(), place_of_supply: $('nPos').value,
      assigned_to: $('nOwner').value,
      lines: lines
    }).then(function (res) {
      toast('Raised ' + res.request_id);
      if (A.accountOpen) loadCompanies();
      loadRequests();
    }).catch(function (e) { $('nSave').disabled = false; $('nSaveTop').disabled = false; $('mErr').textContent = e.message; });
  };
}

/* ================= DECKS ================= */

function loadDecks() {
  A.loaded.decks = true;
  $('p-decks').innerHTML = '<div class="spin"></div>';
  var need = [api('adminDecks')];
  if (!A.products.length) need.push(api('adminCatalog').then(function (res) { A.products = res.products; A.brands = res.brands; }));
  if (!A.companies.length && !A.loaded.companies) need.push(api('adminCompanies').then(function (res) { A.companies = res.companies; A.contacts = res.contacts; }).catch(function () {}));
  Promise.all(need).then(function (r) { A.decks = r[0].decks; renderDecks(); })
    .catch(function (e) { $('p-decks').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
}

function renderDecks() {
  $('p-decks').innerHTML =
    '<div class="panel-head"><h2>Product decks</h2><span class="sp"></span>' +
      '<button class="btn primary small" id="dkNew">+ Deck</button></div>' +
    '<p class="note" style="margin-top:-6px">Pick products, get a PDF and a PowerPoint with image, specs, MOQ, price tiers and stock as of now, under the company identity in Settings. Files land in Drive under Merchforce / Decks and can be sent from here.</p>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>Deck</th><th>For</th><th class="num">Products</th><th>Created</th><th>Files</th><th>Sent to</th><th></th>' +
    '</tr></thead><tbody id="dkRows"></tbody></table></div>';
  var tb = $('dkRows');
  if (!A.decks.length) tb.innerHTML = '<tr><td colspan="7"><div class="empty" style="padding:26px 0">No decks yet.</div></td></tr>';
  A.decks.forEach(function (d) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><b>' + esc(d.name) + '</b><br><small style="color:var(--ink-3)">' + esc(d.id) + ' · ' + esc(d.created_by) + '</small></td>' +
      '<td>' + esc(d.company || '—') + '</td>' +
      '<td class="num">' + d.skus.length + '</td>' +
      '<td>' + fmtDate(d.created) + '</td>' +
      '<td>' + (d.pdf_url ? '<a href="' + esc(d.pdf_url) + '" target="_blank">PDF ↗</a>' : '') +
             (d.pptx_url ? ' · <a href="' + esc(d.pptx_url) + '" target="_blank">PPTX ↗</a>' : '') + '</td>' +
      '<td><small>' + esc(d.sent_to || '—') + '</small></td>' +
      '<td class="num"><button class="btn small" data-send="' + esc(d.id) + '">Send</button> ' +
        '<button class="btn small" data-del="' + esc(d.id) + '" title="Delete deck and its files">×</button></td>';
    tb.appendChild(tr);
  });
  $('dkNew').onclick = newDeck;
  tb.querySelectorAll('button[data-send]').forEach(function (b) {
    b.onclick = function () { sendDeck(A.decks.filter(function (x) { return x.id === b.dataset.send; })[0]); };
  });
  tb.querySelectorAll('button[data-del]').forEach(function (b) {
    b.onclick = function () {
      if (!confirm('Delete this deck and its files from Drive?')) return;
      b.disabled = true;
      api('adminDeckDelete', { id: b.dataset.del }).then(function () { toast('Deck deleted'); loadDecks(); })
        .catch(function (e) { b.disabled = false; toast(e.message); });
    };
  });
}

function newDeck() {
  var picked = {};
  var catalogue = A.products.filter(function (p) { return p.visible; });
  var brands = {};
  A.brands.forEach(function (b) { brands[b.id] = b.name; });
  var companies = A.companies.filter(function (c) { return c.active; });

  openDrawer(
    '<h2 style="margin:0 0 4px">New deck</h2>' +
    '<p class="note" style="margin:0 0 14px">Image, specs, MOQ, price tiers and stock as of now, plus an at-a-glance table at the end. Cover carries the company identity; colours and density come from Settings → Deck design.</p>' +
    '<div class="f2">' +
      '<div class="field"><label>Deck name *</label><input id="dName" placeholder="e.g. Drinkware selection — Sept"></div>' +
      pickerField('dCompany', 'Prepared for', 'account, optional') +
    '</div>' +
    '<div class="section-head" style="margin-top:10px"><h2 style="font-size:15px">Products <span id="dCount" class="pill" style="background:var(--accent-soft);color:var(--accent)">0</span></h2></div>' +
    '<div style="display:flex;gap:8px;margin-bottom:8px">' +
      '<input id="dFilter" placeholder="filter by name, SKU, brand or category" style="flex:1">' +
      '<button class="btn small" id="dAll">Select shown</button><button class="btn small" id="dNone">Clear</button>' +
    '</div>' +
    '<div id="dList" style="max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:12px"></div>' +
    '<div class="form-err" id="mErr"></div>' +
    '<div style="display:flex;gap:10px;margin-top:14px">' +
      '<button class="btn primary" id="dBuild" style="flex:1;justify-content:center">Generate PDF + PPTX</button>' +
    '</div>' +
    '<p class="note" id="dOut" style="margin-top:8px"></p>');

  attachPicker($('dCompany'), $('dCompanyPick'), companies, { text: function (c) { return c.name; }, sub: function (c) { return [c.id, c.bill && c.bill.city, c.owner].filter(String).join(' · '); }, free: true, empty: 'No account with that name' });
  function shown() {
    var q = $('dFilter').value.trim().toLowerCase();
    return catalogue.filter(function (p) {
      if (!q) return true;
      return [p.sku, p.name, brands[p.brand_id] || '', p.category || ''].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function paint() {
    var rows = shown();
    $('dCount').textContent = String(Object.keys(picked).length);
    $('dList').innerHTML = rows.length ? rows.map(function (p) {
      return '<label style="display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer">' +
        '<input type="checkbox" data-sku="' + esc(p.sku) + '"' + (picked[p.sku] ? ' checked' : '') + '>' +
        (p.images[0] ? '<img src="' + esc(p.images[0]) + '" style="width:36px;height:36px;object-fit:contain;background:#fff;border-radius:6px">' : '<span style="width:36px;height:36px;border-radius:6px;background:var(--accent-soft);display:inline-block"></span>') +
        '<span style="flex:1;min-width:0"><b>' + esc(p.name) + '</b><br><small style="color:var(--ink-3)">' + esc(p.sku) + ' · ' + esc(brands[p.brand_id] || '') + ' · MOQ ' + p.moq + ' · ' + qty(p.atp) + ' available</small></span>' +
        '</label>';
    }).join('') : '<div class="empty" style="padding:18px 0">Nothing matches</div>';
    $('dList').querySelectorAll('input[data-sku]').forEach(function (cb) {
      cb.onchange = function () { if (cb.checked) picked[cb.dataset.sku] = 1; else delete picked[cb.dataset.sku]; $('dCount').textContent = String(Object.keys(picked).length); };
    });
  }
  paint();
  $('dFilter').oninput = paint;
  $('dAll').onclick = function () { shown().forEach(function (p) { picked[p.sku] = 1; }); paint(); };
  $('dNone').onclick = function () { picked = {}; paint(); };

  $('dBuild').onclick = function () {
    var name = $('dName').value.trim();
    var skus = Object.keys(picked);
    if (!name) { $('mErr').textContent = 'Give the deck a name.'; return; }
    if (!skus.length) { $('mErr').textContent = 'Tick at least one product.'; return; }
    var coName = $('dCompany').value.trim();
    var co = companies.filter(function (c) { return c.name.toLowerCase() === coName.toLowerCase(); })[0];
    $('dBuild').disabled = true; $('mErr').textContent = '';
    $('dOut').textContent = 'Building ' + skus.length + ' product' + (skus.length === 1 ? '' : 's') + '… images are fetched and both files rendered, so this takes a moment.';
    api('adminDeckBuild', { name: name, skus: skus, company: coName, company_id: co ? co.id : '' }).then(function (res) {
      closeDrawer();
      toast('Deck ' + res.id + ' ready' + (res.missing ? ' · ' + res.missing + ' SKU(s) not found' : ''));
      loadDecks();
    }).catch(function (e) { $('dBuild').disabled = false; $('dOut').textContent = ''; $('mErr').textContent = e.message; });
  };
}

function sendDeck(d) {
  var contacts = d.company_id ? contactsOf(d.company_id) : [];
  openDrawer(
    '<h2 style="margin:0 0 4px">Send ' + esc(d.name) + '</h2>' +
    '<p class="note" style="margin:0 0 14px">Emails the PDF and PowerPoint links' + (d.company ? ' — prepared for ' + esc(d.company) : '') + '. Goes out through your notification email setup, so it leaves from the configured address.</p>' +
    pickerField('sTo', 'To *', 'contact at the account, or any address') +
    '<div class="field"><label>Message</label><textarea id="sMsg" rows="4" style="width:100%;border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit" placeholder="a line or two — the links and the standard footer are added"></textarea></div>' +
    '<div class="form-err" id="mErr"></div>' +
    '<button class="btn primary" id="sSend" style="width:100%;justify-content:center">Send</button>');
  attachPicker($('sTo'), $('sToPick'), contacts.filter(function (c) { return c.email; }), { text: function (c) { return c.email; }, sub: function (c) { return [c.name, c.role].filter(String).join(' · '); }, value: function (c) { return c.email; }, free: true, empty: 'No contact with an email on this account; type an address' });
  $('sSend').onclick = function () {
    var to = $('sTo').value.trim();
    if (!to) { $('mErr').textContent = 'Who is it going to?'; return; }
    $('sSend').disabled = true;
    api('adminDeckSend', { id: d.id, to: to, message: $('sMsg').value }).then(function (res) {
      closeDrawer(); toast('Sent via ' + res.via); loadDecks();
    }).catch(function (e) { $('sSend').disabled = false; $('mErr').textContent = e.message; });
  };
}

/* ================= COMPANIES ================= */

function editContact(companyId, ct, done) {
  var isNew = !ct;
  ct = ct || { id: '', name: '', email: '', phone: '', role: '', consent: false, unsubscribed: false, consent_source: '', consent_ts: '' };
  openDrawer(
    '<h2 style="margin:0 0 14px">' + (isNew ? 'New contact' : esc(ct.name || ct.email)) + '</h2>' +
    '<div class="f2">' +
      '<div class="field"><label>Name</label><input id="tName" value="' + esc(ct.name) + '"></div>' +
      '<div class="field"><label>Email</label><input id="tEmail" value="' + esc(ct.email) + '"></div>' +
      '<div class="field"><label>Phone</label><input id="tPhone" value="' + esc(ct.phone) + '"></div>' +
      '<div class="field"><label>Role</label><input id="tRole" value="' + esc(ct.role) + '" placeholder="buyer, finance, admin"></div>' +
    '</div>' +
    '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:14px;margin:6px 0"><input id="tConsent" type="checkbox"' + (ct.consent ? ' checked' : '') + '> Consented to marketing email</label>' +
    '<div class="field"><label>How consent was given</label><input id="tSource" value="' + esc(ct.consent_source) + '" placeholder="signed form, replied opting in, asked at a meeting"></div>' +
    (ct.consent_ts ? '<p class="note">Consent recorded ' + esc(ct.consent_ts) + '.</p>' : '') +
    '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:14px;margin:6px 0"><input id="tUnsub" type="checkbox"' + (ct.unsubscribed ? ' checked' : '') + '> Unsubscribed</label>' +
    '<p class="note">Campaigns skip anyone without consent, and anyone unsubscribed, whatever else is set. Under the DPDP Act a record of when and how consent was given is the point, not the tick itself.</p>' +
    '<div class="form-err" id="mErr"></div>' +
    '<div style="display:flex;gap:10px;margin-top:14px">' +
      '<button class="btn primary" id="tSave" style="flex:1;justify-content:center">Save contact</button>' +
    '</div>');

  $('tSave').onclick = function () {
    $('tSave').disabled = true;
    api('adminContactSave', { actor: 'admin', contact: {
      id: ct.id, company_id: companyId,
      name: $('tName').value.trim(), email: $('tEmail').value.trim(),
      phone: $('tPhone').value.trim(), role: $('tRole').value.trim(),
      consent: $('tConsent').checked, consent_source: $('tSource').value.trim(),
      unsubscribed: $('tUnsub').checked
    } }).then(function () {
      closeDrawer(); toast('Contact saved');
      api('adminCompanies').then(function (res) {
        A.companies = res.companies; A.contacts = res.contacts;
        A.unlinked = { names: res.unlinked_names, orders: res.unlinked_orders };
        if (done) { editCompany(A.companies.filter(function (x) { return x.id === companyId; })[0]); }
      });
    }).catch(function (e) { $('tSave').disabled = false; $('mErr').textContent = e.message; });
  };
}

/* ================= STOCK (phase 5) ================= */
/* Reorder, fulfilment queue, production plan (made in house) and purchase
   plan (bought from vendors). All measured from StockLog and the order book;
   nothing here is a forecast. */

A.stockView = A.stockView || 'reorder';

function loadStock() {
  A.loaded.stock = true;
  $('p-stock').innerHTML = '<div class="spin"></div>';
  api('adminStock').then(function (res) { A.stock = res; renderStock(); })
    .catch(function (e) { $('p-stock').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
}

function refreshStock() {
  return api('adminStock').then(function (res) { A.stock = res; renderStock(); });
}

function modePill(mode) {
  return '<span class="pill ' + (mode === 'make' ? 'st-InProduction' : 'st-PIAccepted') + '">' + (mode === 'make' ? 'make' : 'buy') + '</span>';
}
function supplyPill(st, kind) {
  var cls = { Planned: 'st-New', Open: 'st-POReceived', Done: 'st-Delivered', Cancelled: 'st-Cancelled' }[st] || 'st-Closed';
  var label = st === 'Open' ? (kind === 'make' ? 'Started' : 'Ordered') : st;
  return '<span class="pill ' + cls + '">' + esc(label) + '</span>';
}
function stockProduct(sku) {
  return (A.stock.products || []).filter(function (p) { return p.sku === sku; })[0];
}

function renderStock() {
  var D = A.stock, c = D.counts;
  var views = [['reorder', 'Reorder'], ['queue', 'Fulfilment'], ['make', 'Production'], ['buy', 'Purchases']];
  $('p-stock').innerHTML =
    '<div class="panel-head"><h2>Stock</h2>' +
      '<span style="color:var(--ink-3);font-size:13px;font-weight:600">consumption over ' + D.measured_over_days + ' days · ' + esc(D.generated_at) + '</span>' +
      '<span class="sp"></span>' +
      '<div class="seg" id="stkSeg">' + views.map(function (v) {
        return '<button data-v="' + v[0] + '"' + (A.stockView === v[0] ? ' class="on"' : '') + '>' + v[1] + '</button>';
      }).join('') + '</div></div>' +
    '<div class="stat-row">' +
      stat(c.out_of_stock, 'out of stock') + stat(c.reorder_due, 'at or below reorder point') +
      stat(c.overdue + '<span style="color:var(--ink-3);font-size:14px"> / ' + c.queue + '</span>', 'orders past stage SLA') +
      stat(c.make_open, 'production runs open') + stat(c.buy_open, 'purchases open') +
    '</div>' +
    '<div id="stkBody"></div>';
  $('stkSeg').querySelectorAll('button').forEach(function (b) {
    b.onclick = function () { A.stockView = b.dataset.v; renderStock(); };
  });
  ({ reorder: renderReorder, queue: renderQueue, make: renderPlan, buy: renderPlan })[A.stockView]();
}

/* ---------- reorder ---------- */

function renderReorder() {
  var D = A.stock, rows = D.reorder;
  var f = A.reorderFilter || 'all';
  var shown = rows.filter(function (r) { return f === 'all' || r.mode === f; });
  $('stkBody').innerHTML =
    '<div class="panel-head" style="margin-top:6px"><h3 style="margin:0">Reorder</h3>' +
      '<div class="chips" style="margin:0 0 0 14px" id="roChips">' +
        [['all', 'All'], ['make', 'Made in house'], ['buy', 'Bought in']].map(function (x) {
          return '<button class="chip' + (f === x[0] ? ' on' : '') + '" data-f="' + x[0] + '">' + x[1] + '</button>';
        }).join('') + '</div>' +
      '<span class="sp"></span>' +
      '<button class="btn small" id="roAlert" title="Email this list to the notification address now">Email digest</button>' +
      '<label class="note" style="margin:0 0 0 10px;display:flex;align-items:center;gap:6px"><input type="checkbox" id="roDaily"' + (D.reorder_alert === 'daily' ? ' checked' : '') + '> daily at 8am</label>' +
    '</div>' +
    '<p class="note" style="margin-top:-4px">Products whose available to promise (on hand − reserved − safety) is at or below their reorder point. ' +
      'Suggested quantity covers lead time plus ' + D.cover_days + ' days at the measured rate, plus safety stock, less what is already on order or in production, rounded up to the lot ' +
      '(production batch for made goods, vendor MOQ for bought goods).' +
      (D.counts.supply_mode_unset ? ' <b>' + D.counts.supply_mode_unset + ' product' + (D.counts.supply_mode_unset === 1 ? ' has' : 's have') + ' no supply mode set</b> and default to bought in; set it from the Supply button on each row.' : '') +
      (D.counts.no_reorder_point ? ' ' + D.counts.no_reorder_point + ' product' + (D.counts.no_reorder_point === 1 ? ' has' : 's have') + ' no reorder point, so only appear here once they run out.' : '') +
    '</p>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>Product</th><th>Mode</th><th class="num">ATP</th><th class="num">Point</th><th class="num">Rate/day</th><th class="num">Cover</th>' +
      '<th class="num">Inbound</th><th class="num">Suggest</th><th></th>' +
    '</tr></thead><tbody id="roRows"></tbody></table></div>';

  var tb = $('roRows');
  if (!shown.length) tb.innerHTML = '<tr><td colspan="9"><div class="empty" style="padding:26px 0">Nothing at or below its reorder point.</div></td></tr>';
  shown.forEach(function (r) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><b>' + esc(r.name) + '</b><br><small style="color:var(--ink-3)">' + esc(r.sku) + (r.vendor ? ' · ' + esc(r.vendor) : '') + (r.last_out ? ' · last out ' + esc(r.last_out) : '') + '</small></td>' +
      '<td>' + modePill(r.mode) + '</td>' +
      '<td class="num">' + (r.atp <= 0 ? '<span class="badge out">' + qty(r.atp) + '</span>' : '<span class="badge low">' + qty(r.atp) + '</span>') + '</td>' +
      '<td class="num">' + (r.reorder_point ? qty(r.reorder_point) : '<span style="color:var(--ink-3)">not set</span>') + '</td>' +
      '<td class="num">' + r.rate_per_day + '</td>' +
      '<td class="num">' + (r.days_cover === null ? '<span style="color:var(--ink-3)">no dispatches</span>' : r.days_cover + ' d') + '</td>' +
      '<td class="num">' + (r.inbound ? qty(r.inbound) : '—') + '</td>' +
      '<td class="num">' + (r.covered ? '<span class="badge in">covered</span>' : '<b>' + qty(r.suggest_qty) + '</b>') + '</td>' +
      '<td class="num" style="white-space:nowrap">' +
        '<button class="btn small" data-fields="' + esc(r.sku) + '">Supply</button> ' +
        '<button class="btn primary small" data-plan="' + esc(r.sku) + '"' + (r.covered ? ' disabled' : '') + '>' + (r.mode === 'make' ? 'Plan run' : 'Plan purchase') + '</button></td>';
    tb.appendChild(tr);
  });
  $('roChips').querySelectorAll('.chip').forEach(function (b) { b.onclick = function () { A.reorderFilter = b.dataset.f; renderReorder(); }; });
  tb.querySelectorAll('button[data-fields]').forEach(function (b) { b.onclick = function () { editSupplyFields(b.dataset.fields); }; });
  tb.querySelectorAll('button[data-plan]').forEach(function (b) {
    b.onclick = function () {
      var r = rows.filter(function (x) { return x.sku === b.dataset.plan; })[0];
      newSupply({ sku: r.sku, kind: r.mode, qty: r.suggest_qty, vendor: r.vendor, lead_days: r.lead_days });
    };
  });
  $('roAlert').onclick = function () {
    $('roAlert').disabled = true;
    api('adminStockAlert').then(function (res) {
      toast(res.sent ? 'Sent to ' + res.to + ' via ' + res.via : 'Not sent: ' + res.reason);
    }).catch(function (e) { toast(e.message); }).then(function () { $('roAlert').disabled = false; });
  };
  $('roDaily').onchange = function () {
    var mode = $('roDaily').checked ? 'daily' : 'off';
    api('adminStockSchedule', { mode: mode }).then(function (res) {
      A.stock.reorder_alert = res.mode;
      toast(res.mode === 'daily' ? 'Reorder digest goes out daily at 8am to the notification address' : 'Daily digest off');
    }).catch(function (e) { toast(e.message); $('roDaily').checked = D.reorder_alert === 'daily'; });
  };
}

function editSupplyFields(sku) {
  var p = stockProduct(sku);
  if (!p) return;
  openDrawer(
    '<h2 style="margin:0 0 4px">' + esc(p.name) + '</h2>' +
    '<p class="note" style="margin:0 0 14px">' + esc(p.sku) + ' · how this product is replenished. Nothing else on the product changes.</p>' +
    '<div class="field"><label>Supply mode</label><select id="sfMode">' +
      '<option value="buy"' + (p.mode === 'buy' ? ' selected' : '') + '>Bought from a vendor (purchase plan)</option>' +
      '<option value="make"' + (p.mode === 'make' ? ' selected' : '') + '>Made in house (production plan)</option></select></div>' +
    '<div class="f2">' +
      '<div class="field"><label>Vendor</label><input id="sfVendor" value="' + esc(p.vendor) + '" placeholder="who supplies it"></div>' +
      '<div class="field"><label>Lead time</label><input id="sfLead" value="' + esc(p.lead_days) + '" placeholder="days"></div>' +
      '<div class="field"><label>Vendor MOQ <small style="font-weight:400">(buy: lot size)</small></label><input id="sfVmoq" type="number" min="0" value="' + (p.vendor_moq || '') + '" placeholder="blank = catalogue MOQ ' + p.moq + '"></div>' +
      '<div class="field"><label>Batch size <small style="font-weight:400">(make: lot size)</small></label><input id="sfBatch" type="number" min="0" value="' + (p.batch_qty || '') + '" placeholder="blank = catalogue MOQ ' + p.moq + '"></div>' +
      '<div class="field"><label>Reorder point</label><input id="sfRop" type="number" min="0" value="' + p.reorder_point + '"></div>' +
      '<div class="field"><label>Safety stock</label><input id="sfSafety" type="number" min="0" value="' + p.safety_stock + '"></div>' +
    '</div>' +
    '<p class="note">ATP now ' + qty(p.atp) + ' (on hand ' + qty(p.on_hand) + '). The reorder point is typed by hand until there is enough dispatch history to derive it.</p>' +
    '<div class="form-err" id="mErr"></div>' +
    '<button class="btn primary" id="sfSave" style="width:100%;justify-content:center">Save</button>');
  $('sfSave').onclick = function () {
    $('sfSave').disabled = true;
    api('adminSupplyFields', {
      sku: p.sku, supply_mode: $('sfMode').value, vendor: $('sfVendor').value.trim(),
      lead_time: $('sfLead').value.trim(), vendor_moq: $('sfVmoq').value, batch_qty: $('sfBatch').value,
      reorder_point: $('sfRop').value, safety_stock: $('sfSafety').value
    }).then(function () { closeDrawer(); toast('Saved'); A.loaded.catalog = false; return refreshStock(); })
      .catch(function (e) { $('sfSave').disabled = false; $('mErr').textContent = e.message; });
  };
}

/* ---------- fulfilment queue ---------- */

function renderQueue() {
  var rows = A.stock.queue;
  $('stkBody').innerHTML =
    '<h3 style="margin:6px 0 4px">Fulfilment queue</h3>' +
    '<p class="note" style="margin-top:0">Orders from PO Received onward, oldest against their stage SLA first (PO Received 7 days, In Production 21, Dispatched 10). ' +
      'A line is short when on hand went negative at PO Received: the order was promised units the shelf did not have.</p>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>Order</th><th>Company</th><th>Stage</th><th class="num">In stage</th><th class="num">Lines</th><th class="num">Units</th><th class="num">Shipped</th><th>Stock</th><th></th>' +
    '</tr></thead><tbody id="fqRows"></tbody></table></div>';
  var tb = $('fqRows');
  if (!rows.length) tb.innerHTML = '<tr><td colspan="9"><div class="empty" style="padding:26px 0">Nothing in fulfilment.</div></td></tr>';
  rows.forEach(function (r) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><b>' + esc(r.id) + '</b>' + (r.po_number ? '<br><small style="color:var(--ink-3)">PO ' + esc(r.po_number) + '</small>' : '') + '</td>' +
      '<td>' + esc(r.company) + '</td>' +
      '<td>' + statusPill(r.status) + '</td>' +
      '<td class="num">' + (r.overdue ? '<span class="badge out">' + r.age_days + ' d</span>' : r.age_days + ' d') + '<br><small style="color:var(--ink-3)">SLA ' + r.sla_days + '</small></td>' +
      '<td class="num">' + r.lines + '</td>' +
      '<td class="num">' + qty(r.units) + '</td>' +
      '<td class="num">' + (r.shipped ? qty(r.shipped) : '—') + '</td>' +
      '<td>' + (r.short.length ? '<span class="badge out">short</span> <small>' + esc(r.short.join(', ')) + '</small>' : '<span class="badge in">covered</span>') + '</td>' +
      '<td class="num"><button class="btn small" data-open="' + esc(r.id) + '">Open</button></td>';
    tb.appendChild(tr);
  });
  tb.querySelectorAll('button[data-open]').forEach(function (b) {
    b.onclick = function () {
      var r = rows.filter(function (x) { return x.id === b.dataset.open; })[0];
      goTab('orders');
      openOrder(r.order);
    };
  });
}

/* ---------- production plan / purchase plan ---------- */

function renderPlan() {
  var kind = A.stockView;                       // 'make' | 'buy'
  var all = A.stock.supply.filter(function (s) { return s.kind === kind; });
  var open = all.filter(function (s) { return s.status === 'Planned' || s.status === 'Open'; });
  var done = all.filter(function (s) { return s.status === 'Done' || s.status === 'Cancelled'; });
  var isMake = kind === 'make';
  var labels = isMake
    ? { title: 'Production plan', unit: 'run', open: 'Started', receive: 'Record output', ref: 'Batch', who: '' }
    : { title: 'Purchase plan', unit: 'purchase', open: 'Ordered', receive: 'Receive', ref: 'PO no.', who: 'Vendor' };

  // weekly load: open quantity by expected week
  var weeks = {};
  open.forEach(function (s) {
    var d = s.expected ? new Date(s.expected) : null;
    var key = d && !isNaN(d.getTime()) ? weekKey(d) : 'unscheduled';
    weeks[key] = (weeks[key] || 0) + Math.max(0, s.qty - s.received_qty);
  });
  var weekKeys = Object.keys(weeks).sort(function (a, b) { return a === 'unscheduled' ? 1 : b === 'unscheduled' ? -1 : a < b ? -1 : 1; });

  // purchases group by vendor
  var groups = {};
  open.forEach(function (s) {
    var g = isMake ? 'Runs' : (s.vendor || 'No vendor');
    (groups[g] = groups[g] || []).push(s);
  });

  $('stkBody').innerHTML =
    '<div class="panel-head" style="margin-top:6px"><h3 style="margin:0">' + labels.title + '</h3><span class="sp"></span>' +
      '<button class="btn primary small" id="plNew">+ ' + (isMake ? 'Production run' : 'Purchase') + '</button></div>' +
    '<p class="note" style="margin-top:-4px">' + (isMake
      ? 'Runs for goods made in house. Planned → Started → Done when the output is recorded, which adds it to on hand through StockLog. Open runs count as inbound on the reorder screen.'
      : 'Purchases from vendors. Planned → Ordered → Done when the goods are received, which adds them to on hand through StockLog. Open purchases count as inbound on the reorder screen.') + '</p>' +
    (weekKeys.length ? '<div class="stat-row">' + weekKeys.slice(0, 6).map(function (k) {
      return stat(qty(weeks[k]), k === 'unscheduled' ? 'unscheduled' : 'week of ' + fmtDay(k));
    }).join('') + '</div>' : '') +
    Object.keys(groups).sort().map(function (g) {
      return (isMake ? '' : '<h4 style="margin:14px 0 6px">' + esc(g) + ' <small style="color:var(--ink-3);font-weight:600">· ' + groups[g].length + ' open</small></h4>') +
        planTable(groups[g], labels, isMake);
    }).join('') +
    (!open.length ? '<div class="empty" style="padding:26px 0">No open ' + labels.unit + 's.</div>' : '') +
    (done.length ? '<details style="margin-top:16px"><summary style="cursor:pointer;font-weight:700;color:var(--ink-2)">Completed and cancelled (' + done.length + ')</summary>' + planTable(done, labels, isMake) + '</details>' : '');

  $('plNew').onclick = function () { newSupply({ kind: kind }); };
  $('stkBody').querySelectorAll('button[data-so]').forEach(function (b) {
    b.onclick = function () {
      var s = all.filter(function (x) { return x.id === b.dataset.so; })[0];
      var act = b.dataset.act;
      if (act === 'edit') return editSupply(s);
      if (act === 'receive') return receiveSupply(s, labels);
      if (act === 'open') return saveSupply({ id: s.id, status: 'Open' }, labels.open);
      if (act === 'cancel') { if (confirm('Cancel ' + s.id + '?')) saveSupply({ id: s.id, status: 'Cancelled' }, 'Cancelled'); return; }
      if (act === 'del') {
        if (!confirm('Delete ' + s.id + '? Only possible while nothing has been received against it.')) return;
        api('adminSupplyDelete', { id: s.id }).then(function () { toast('Deleted'); return refreshStock(); }).catch(function (e) { toast(e.message); });
      }
    };
  });
}

function fmtDay(d) {
  var x = new Date(d);
  return isNaN(x) ? esc(String(d)) : x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function weekKey(d) {
  var m = new Date(d); m.setDate(m.getDate() - ((m.getDay() + 6) % 7));   // Monday
  return m.toISOString().slice(0, 10);
}

function planTable(list, labels, isMake) {
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
    '<th>' + (isMake ? 'Run' : 'Purchase') + '</th><th>Product</th>' + (isMake ? '' : '<th>Vendor</th>') +
    '<th class="num">Qty</th><th class="num">Received</th><th>Expected</th><th>' + labels.ref + '</th><th>Status</th><th></th>' +
    '</tr></thead><tbody>' + list.map(function (s) {
      var live = s.status === 'Planned' || s.status === 'Open';
      var exp = s.expected ? fmtDay(s.expected) : '<span style="color:var(--ink-3)">—</span>';
      var late = live && s.expected && new Date(s.expected).getTime() < Date.now() - 864e5;
      return '<tr>' +
        '<td><b>' + esc(s.id) + '</b><br><small style="color:var(--ink-3)">' + esc(s.created_by) + ' · ' + fmtDate(s.created) + '</small></td>' +
        '<td>' + esc(s.name) + '<br><small style="color:var(--ink-3)">' + esc(s.sku) + '</small></td>' +
        (isMake ? '' : '<td>' + esc(s.vendor || '—') + '</td>') +
        '<td class="num">' + qty(s.qty) + '</td>' +
        '<td class="num">' + (s.received_qty ? qty(s.received_qty) : '—') + '</td>' +
        '<td>' + (late ? '<span class="badge out">' + exp + '</span>' : exp) + '</td>' +
        '<td>' + esc(s.ref || '—') + (s.note ? '<br><small style="color:var(--ink-3)">' + esc(s.note) + '</small>' : '') + '</td>' +
        '<td>' + supplyPill(s.status, s.kind) + '</td>' +
        '<td class="num" style="white-space:nowrap">' + (live
          ? '<button class="btn small" data-so="' + esc(s.id) + '" data-act="edit">Edit</button> ' +
            (s.status === 'Planned' ? '<button class="btn small" data-so="' + esc(s.id) + '" data-act="open">' + labels.open + '</button> ' : '') +
            '<button class="btn primary small" data-so="' + esc(s.id) + '" data-act="receive">' + labels.receive + '</button> ' +
            (s.received_qty ? '<button class="btn small" data-so="' + esc(s.id) + '" data-act="cancel" title="Cancel the remainder">×</button>'
                            : '<button class="btn small" data-so="' + esc(s.id) + '" data-act="del" title="Delete">×</button>')
          : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function saveSupply(patch, label) {
  return api('adminSupplySave', { supply: patch }).then(function () { toast(label || 'Saved'); return refreshStock(); })
    .catch(function (e) { toast(e.message); });
}

function supplyForm(s, isNew) {
  var isMake = s.kind === 'make';
  var products = A.stock.products.filter(function (p) { return isNew ? p.mode === s.kind : true; });
  if (isNew && !products.filter(function (p) { return p.sku === s.sku; }).length) products = A.stock.products;
  return '<h2 style="margin:0 0 4px">' + (isNew ? 'New ' + (isMake ? 'production run' : 'purchase') : esc(s.id)) + '</h2>' +
    '<p class="note" style="margin:0 0 14px">' + (isMake ? 'Goods made in house.' : 'Goods bought from a vendor.') + (isNew ? '' : ' ' + esc(s.name) + ' · ' + esc(s.sku)) + '</p>' +
    (isNew ? '<div class="field"><label>Product</label><select id="soSku">' +
      '<option value="">Choose…</option>' + products.map(function (p) {
        return '<option value="' + esc(p.sku) + '"' + (p.sku === s.sku ? ' selected' : '') + '>' + esc(p.name) + ' · ' + esc(p.sku) + ' · ATP ' + qty(p.atp) + '</option>';
      }).join('') + '</select></div>' : '') +
    '<div class="f2">' +
      '<div class="field"><label>Quantity</label><input id="soQty" type="number" min="1" value="' + (s.qty || '') + '"></div>' +
      '<div class="field"><label>Expected ' + (isMake ? 'finish' : 'delivery') + '</label><input id="soExp" type="date" value="' + esc(s.expected || '') + '"></div>' +
      (isMake ? '' : '<div class="field"><label>Vendor</label><input id="soVendor" value="' + esc(s.vendor || '') + '"></div>') +
      '<div class="field"><label>' + (isMake ? 'Batch / job no.' : 'PO number') + '</label><input id="soRef" value="' + esc(s.ref || '') + '"></div>' +
    '</div>' +
    '<div class="field"><label>Note</label><input id="soNote" value="' + esc(s.note || '') + '"></div>' +
    '<div class="form-err" id="mErr"></div>' +
    '<button class="btn primary" id="soSave" style="width:100%;justify-content:center">' + (isNew ? 'Add to plan' : 'Save') + '</button>';
}

function readSupplyForm(isMake) {
  return {
    qty: $('soQty').value, expected: $('soExp').value, ref: $('soRef').value.trim(), note: $('soNote').value.trim(),
    vendor: isMake ? undefined : $('soVendor').value.trim()
  };
}

function newSupply(pre) {
  pre = pre || {};
  var kind = pre.kind === 'make' ? 'make' : 'buy';
  var s = { kind: kind, sku: pre.sku || '', qty: pre.qty || '', vendor: pre.vendor || '', ref: '', note: '', expected: '' };
  if (pre.lead_days) { var d = new Date(); d.setDate(d.getDate() + pre.lead_days); s.expected = d.toISOString().slice(0, 10); }
  openDrawer(supplyForm(s, true));
  $('soSku').onchange = function () {
    var p = stockProduct($('soSku').value);
    if (!p) return;
    if ($('soVendor') && !$('soVendor').value) $('soVendor').value = p.vendor || '';
    if (!$('soQty').value) $('soQty').value = p.lot;
    if (!$('soExp').value && p.lead_days) { var d = new Date(); d.setDate(d.getDate() + p.lead_days); $('soExp').value = d.toISOString().slice(0, 10); }
  };
  $('soSave').onclick = function () {
    var sku = $('soSku').value;
    if (!sku) { $('mErr').textContent = 'Choose a product'; return; }
    $('soSave').disabled = true;
    var body = readSupplyForm(kind === 'make');
    body.sku = sku; body.kind = kind;
    api('adminSupplySave', { supply: body }).then(function (res) {
      closeDrawer(); toast(res.supply.id + ' added to the ' + (kind === 'make' ? 'production' : 'purchase') + ' plan');
      A.stockView = kind; return refreshStock();
    }).catch(function (e) { $('soSave').disabled = false; $('mErr').textContent = e.message; });
  };
}

function editSupply(s) {
  openDrawer(supplyForm(s, false));
  $('soSave').onclick = function () {
    $('soSave').disabled = true;
    var body = readSupplyForm(s.kind === 'make');
    body.id = s.id;
    api('adminSupplySave', { supply: body }).then(function () { closeDrawer(); toast('Saved'); return refreshStock(); })
      .catch(function (e) { $('soSave').disabled = false; $('mErr').textContent = e.message; });
  };
}

function receiveSupply(s, labels) {
  var left = Math.max(0, s.qty - s.received_qty);
  openDrawer(
    '<h2 style="margin:0 0 4px">' + labels.receive + ' · ' + esc(s.id) + '</h2>' +
    '<p class="note" style="margin:0 0 14px">' + esc(s.name) + ' · ' + esc(s.sku) + '. ' + qty(s.received_qty) + ' of ' + qty(s.qty) + ' in so far.</p>' +
    '<div class="field"><label>Quantity ' + (s.kind === 'make' ? 'produced' : 'received') + ' now</label><input id="rvQty" type="number" min="1" value="' + left + '"></div>' +
    '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:14px;margin:6px 0"><input id="rvClose" type="checkbox"> Close the order even if this is less than the balance</label>' +
    '<p class="note">Adds to on hand and writes a StockLog row. A partial quantity leaves the order open for the rest.</p>' +
    '<div class="form-err" id="mErr"></div>' +
    '<button class="btn primary" id="rvSave" style="width:100%;justify-content:center">' + labels.receive + '</button>');
  $('rvSave').onclick = function () {
    $('rvSave').disabled = true;
    api('adminSupplyReceive', { id: s.id, qty: $('rvQty').value, close: $('rvClose').checked }).then(function (res) {
      closeDrawer(); toast(res.supply.status === 'Done' ? s.id + ' complete' : 'Recorded; ' + qty(res.supply.qty - res.supply.received_qty) + ' still to come');
      A.loaded.catalog = false; return refreshStock();
    }).catch(function (e) { $('rvSave').disabled = false; $('mErr').textContent = e.message; });
  };
}

/* ================= USERS ================= */
function loadUsers() {
  A.loaded.users = true;
  $('p-users').innerHTML = '<div class="spin"></div>';
  api('adminUsers').then(function (res) {
    A.users = res.users;
    renderUsers();
  }).catch(function (e) { $('p-users').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
}

function renderUsers() {
  var me = A.user || {};
  $('p-users').innerHTML =
    '<div class="panel-head"><h2>Users</h2>' +
      '<span class="sp"></span><button class="btn primary small" id="uNew">+ User</button></div>' +
    '<p class="note" style="margin-top:-6px">Everyone who uses this console signs in with their own account, so orders, quotations and stock changes are recorded against a person. ' +
      '<b>Admins</b> can also manage users and settings. Sessions lapse after ' + esc(String(A.sessionMinutes)) + ' minutes of inactivity (Settings → Company).</p>' +
    '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>Name</th><th>Email</th><th>Role</th><th>Active</th><th>Last sign-in</th>' +
    '</tr></thead><tbody id="uRows"></tbody></table></div>';
  $('uNew').onclick = function () { editUser(null); };
  var tb = $('uRows');
  if (!A.users.length) tb.innerHTML = '<tr><td colspan="5" class="empty">No users yet. Create the first one, then sign in with it.</td></tr>';
  A.users.forEach(function (u) {
    var tr = document.createElement('tr');
    tr.className = 'click';
    tr.innerHTML = '<td><b>' + esc(u.name || '—') + '</b>' + (me.email && me.email.toLowerCase() === String(u.email).toLowerCase() ? ' <span class="pill" style="background:var(--accent-soft);color:var(--accent)">you</span>' : '') + '</td>' +
      '<td>' + esc(u.email) + '</td><td>' + esc(u.role || 'staff') + '</td>' +
      '<td>' + (u.active ? '✓' : '—') + '</td><td>' + (u.last_login ? fmtDate(u.last_login) : '—') + '</td>';
    tr.onclick = function () { editUser(u); };
    tb.appendChild(tr);
  });
}

function editUser(u) {
  var isNew = !u;
  u = u || { email: '', name: '', role: 'staff', active: true };
  openDrawer(
    '<h2 style="margin:0 0 14px">' + (isNew ? 'New user' : esc(u.name || u.email)) + '</h2>' +
    '<div class="f2">' +
      '<div class="field"><label>Name *</label><input id="uName" value="' + esc(u.name) + '"></div>' +
      '<div class="field"><label>Email *</label><input id="uEmail" type="email" value="' + esc(u.email) + '"' + (isNew ? '' : ' readonly') + '></div>' +
    '</div>' +
    '<div class="f2">' +
      '<div class="field"><label>Role</label><select id="uRole">' +
        '<option value="staff"' + (u.role !== 'admin' ? ' selected' : '') + '>Staff — orders, catalogue, stock</option>' +
        '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>Admin — also users and settings</option>' +
      '</select></div>' +
      '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:14px;margin-top:20px"><input id="uActive" type="checkbox"' + (u.active ? ' checked' : '') + '> Active</label>' +
    '</div>' +
    '<div class="field"><label>' + (isNew ? 'Password * (10+ characters)' : 'New password (leave blank to keep the current one)') + '</label><input id="uPass" type="text" autocomplete="new-password"></div>' +
    '<div class="form-err" id="mErr"></div>' +
    '<button class="btn primary" id="uSave" style="width:100%;justify-content:center">Save user</button>');
  $('uSave').onclick = function () {
    $('uSave').disabled = true;
    api('adminUserSave', { user: {
      email: $('uEmail').value.trim(), name: $('uName').value.trim(), role: $('uRole').value,
      password: $('uPass').value, active: $('uActive').checked
    } }).then(function () { closeDrawer(); toast('User saved'); loadUsers(); })
      .catch(function (e) { $('uSave').disabled = false; $('mErr').textContent = e.message; });
  };
}

/* ================= ANALYTICS (RSM-style) ================= */
function loadAnalytics() {
  A.loaded.analytics = true;
  $('p-analytics').innerHTML = '<div class="spin"></div>';
  var ensureCatalog = A.products.length ? Promise.resolve() : api('adminCatalog').then(function (res) {
    A.products = res.products; A.brands = res.brands;
  });
  ensureCatalog.then(function () {
    return api('adminAnalytics', { days: A.days });
  }).then(function (res) {
    A.analytics = res;
    renderAnalytics();
  }).catch(function (e) { $('p-analytics').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
}

function section(title, note) {
  return '<div class="section-head"><h2>' + title + '</h2>' +
    (note ? '<div class="note-sub">' + note + '</div>' : '') + '</div>';
}
function card2(title, body, note) {
  return '<div class="panel2"><h3>' + title + '</h3>' +
    (note ? '<p class="note-sub">' + note + '</p>' : '') + body + '</div>';
}
function barList(rows, fmt) {
  if (!rows || !rows.length) return '<div class="empty" style="padding:18px 0">Nothing yet</div>';
  var max = Math.max.apply(null, rows.map(function (r) { return r.count; }));
  return '<div class="bars">' + rows.map(function (r) {
    return '<div class="brow"><span class="blabel" title="' + esc(r.key) + '">' + esc(r.key) + '</span>' +
      '<span class="bar-track"><span class="bar-fill" style="display:block;width:' + Math.max(2, Math.round(r.count / max * 100)) + '%"></span></span>' +
      '<span class="bval">' + (fmt || qty)(r.count) + '</span></div>';
  }).join('') + '</div>';
}
function productBars(rows, fmt) {
  if (!rows || !rows.length) return '<div class="empty" style="padding:18px 0">Nothing yet</div>';
  var max = Math.max.apply(null, rows.map(function (r) { return r.value !== undefined ? r.value : r.count; }));
  return '<div class="prod-rows">' + rows.map(function (r, i) {
    var v = r.value !== undefined ? r.value : r.count;
    var img = imgOf(r.sku);
    return '<div class="prod-row"><span class="prod-rank">' + (i + 1) + '</span>' +
      (img ? '<img class="prod-img" loading="lazy" src="' + esc(img) + '">' : '<span class="prod-img"></span>') +
      '<span><span class="prod-name">' + esc(r.name) + '</span><span class="prod-sku">' + esc(r.sku) + '</span>' +
        '<span class="bar-track" style="margin-top:5px;display:block"><span class="bar-fill" style="display:block;width:' + Math.max(2, Math.round(v / max * 100)) + '%"></span></span></span>' +
      '<span class="prod-val">' + fmt(v) + '</span></div>';
  }).join('') + '</div>';
}
function statusBars(byStatus) {
  var rows = Object.keys(byStatus).map(function (k) { return { key: k, count: byStatus[k] }; })
    .sort(function (a, b) { return b.count - a.count; });
  if (!rows.length) return '<div class="empty" style="padding:18px 0">No requests in this window</div>';
  var total = rows.reduce(function (s, r) { return s + r.count; }, 0);
  return '<div class="bars">' + rows.map(function (r) {
    return '<div class="brow"><span class="blabel">' + esc(r.key) + '</span>' +
      '<span class="bar-track"><span class="bar-fill" style="display:block;width:' + Math.round(r.count / total * 100) + '%"></span></span>' +
      '<span class="bval">' + r.count + ' · ' + Math.round(r.count / total * 100) + '%</span></div>';
  }).join('') + '</div>';
}
function dataTable(cols, rows, cell) {
  if (!rows || !rows.length) return '<div class="empty" style="padding:14px 0">Nothing here</div>';
  return '<div style="max-height:340px;overflow:auto"><table class="tbl"><thead><tr>' +
    cols.map(function (c) { return '<th' + (c.num ? ' class="num"' : '') + '>' + esc(c.label) + '</th>'; }).join('') +
    '</tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr>' + cols.map(function (c) {
        return '<td' + (c.num ? ' class="num"' : '') + '>' + cell(r, c.key) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
}

function sparkline(weeks, pick, title, fmt) {
  if (!weeks || weeks.length < 2) return '<div class="empty" style="padding:12px 0">Not enough weeks yet to draw a trend</div>';
  var w = 460, h = 86, pad = 6;
  var vals = weeks.map(pick);
  var max = Math.max.apply(null, [1].concat(vals));
  var step = (w - pad * 2) / (weeks.length - 1);
  function pt(i) { return [pad + i * step, h - pad - (vals[i] / max) * (h - pad * 2)]; }
  var line = vals.map(function (_, i) { return pt(i).join(','); }).join(' ');
  var area = pad + ',' + (h - pad) + ' ' + line + ' ' + (w - pad) + ',' + (h - pad);
  var lastPt = pt(vals.length - 1);
  return '<div style="margin-bottom:14px">' +
    '<div class="row-between"><span style="font-size:12.5px;color:var(--ink-3);font-weight:600">' + title + '</span>' +
    '<strong>' + fmt(vals[vals.length - 1]) + '</strong></div>' +
    '<svg viewBox="0 0 ' + w + ' ' + h + '" class="spark" preserveAspectRatio="none">' +
    '<polygon points="' + area + '" fill="rgba(36,71,245,.10)"></polygon>' +
    '<polyline points="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>' +
    '<circle cx="' + lastPt[0] + '" cy="' + lastPt[1] + '" r="4" fill="var(--accent)" stroke="#fff" stroke-width="2"></circle></svg>' +
    '<div class="row-between" style="font-size:12px;color:var(--ink-3)"><span>' + esc(weeks[0].week) + '</span><span>' + esc(weeks[weeks.length - 1].week) + '</span></div></div>';
}

function renderAnalytics() {
  var D = A.analytics;
  var r = D.requests, d = D.decision, pr = D.products, pl = D.pipeline, st = D.stock, cu = D.customers;

  function stageRows() {
    return Object.keys(pl.stages).filter(function (k) { return pl.stages[k].count; })
      .map(function (k) { return { key: k, count: pl.stages[k].count }; })
      .sort(function (a, b) { return b.count - a.count; });
  }

  $('p-analytics').innerHTML =
    '<div class="panel-head"><h2>Analytics</h2>' +
      '<span style="color:var(--ink-3);font-size:13px;font-weight:600">Last ' + D.days + ' days · generated ' + esc(D.generated_at) + '</span>' +
      '<span class="sp"></span><div class="chips" style="margin:0" id="rangeChips">' +
      [[30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']].map(function (x) {
        return '<button class="chip' + (A.days === x[0] ? ' on' : '') + '" data-d="' + x[0] + '">' + x[1] + '</button>';
      }).join('') + '</div></div>' +

    section('Enquiries', 'Every enquiry raised in this window, however it was raised.') +
    '<div class="stat-row">' +
      stat(qty(r.count), 'Requests') +
      stat(inr(r.value), 'Request value') +
      stat(inr(r.average), 'Average enquiry') +
      stat(d.pi_win_rate === null ? '—' : d.pi_win_rate + '%', 'PI win rate') +
      stat(d.median_hours_to_pi === null ? '—' : d.median_hours_to_pi + ' h', 'Median time to PI') +
      stat(d.median_days_to_deliver === null ? '—' : d.median_days_to_deliver + ' d', 'Median days to deliver') +
    '</div>' +
    (d.awaiting_over_2_days
      ? '<div class="note2 warn"><strong>' + d.awaiting_over_2_days + ' request' + (d.awaiting_over_2_days === 1 ? '' : 's') +
        ' waiting more than 2 days for a first response.</strong> ' + d.awaiting_decision + ' awaiting a decision in total.</div>'
      : '') +
    '<div class="an-two">' +
      card2('Where orders sit', statusBars(r.by_status)) +
      card2('Requests and value by week',
        sparkline(D.trend, function (w) { return w.requests; }, 'Requests per week', qty) +
        sparkline(D.trend, function (w) { return w.value; }, 'Request value per week', inr)) +
    '</div>' +

    section('Fulfilment', 'Open work, and what has sat in one stage past its expected time.') +
    '<div class="stat-row">' +
      stat(qty(pl.open_count), 'Open orders') +
      stat(inr(pl.open_value), 'Open value') +
      stat(qty(pl.ageing_total), 'Past stage SLA') +
      stat(qty(pl.stages['PI Sent'] ? pl.stages['PI Sent'].count : 0), 'PI with the client') +
      stat(qty((pl.stages['PO Received'] ? pl.stages['PO Received'].count : 0) +
               (pl.stages['In Production'] ? pl.stages['In Production'].count : 0)), 'In production') +
    '</div>' +
    '<div class="an-two">' +
      card2('Open orders by stage', barList(stageRows())) +
      card2('Ageing past SLA · ' + pl.ageing_total,
        dataTable([{ label: 'Order', key: 'id' }, { label: 'Company', key: 'company' },
                   { label: 'Stage', key: 'status' }, { label: 'Days', key: 'days_in_stage', num: true },
                   { label: 'Value', key: 'value', num: true }],
          pl.ageing, function (row, k) {
            if (k === 'value') return inr(row.value);
            if (k === 'days_in_stage') return '<strong>' + row.days_in_stage + '</strong> / ' + row.sla;
            return esc(String(row[k] == null ? '' : row[k]));
          }),
        'Days in the current stage against the expected time for that stage.') +
    '</div>' +

    section('Stock', 'Measured from actual dispatches over the window. Not a forecast.') +
    '<div class="stat-row">' +
      stat(qty(st.out_of_stock), 'Out of stock') +
      stat(qty(st.below_reorder_point), 'Below reorder point') +
      stat(qty(st.reorder_total), 'Reorder suggested') +
      stat(qty(st.dead_total), 'No movement') +
      stat(st.abc.A + ' / ' + st.abc.B + ' / ' + st.abc.C, 'ABC split') +
    '</div>' +
    (st.no_reorder_point
      ? '<div class="note2 warn"><strong>' + st.no_reorder_point + ' product' + (st.no_reorder_point === 1 ? ' has' : 's have') +
        ' no reorder point set.</strong> They can never appear in the reorder list. Set one on the product in the Catalog tab.</div>'
      : '') +
    card2('Reorder now · ' + st.reorder_total,
      dataTable([{ label: 'SKU', key: 'sku' }, { label: 'Product', key: 'name' }, { label: 'ABC', key: 'abc' },
                 { label: 'Available', key: 'atp', num: true }, { label: 'Reorder pt', key: 'reorder_point', num: true },
                 { label: 'Per day', key: 'rate_per_day', num: true }, { label: 'Cover', key: 'days_cover', num: true },
                 { label: 'Order', key: 'suggest_qty', num: true }],
        st.reorder, function (row, k) {
          if (k === 'days_cover') return row.days_cover === null ? '—' : row.days_cover + ' d';
          if (k === 'suggest_qty') return '<strong>' + qty(row.suggest_qty) + '</strong>';
          if (k === 'atp' || k === 'reorder_point') return qty(row[k]);
          return esc(String(row[k] == null ? '' : row[k]));
        }),
      'Suggested quantity covers the lead time plus 30 days at the measured rate, rounded up to a whole MOQ.') +
    card2('No movement in ' + st.measured_over_days + ' days · ' + st.dead_total,
      dataTable([{ label: 'SKU', key: 'sku' }, { label: 'Product', key: 'name' },
                 { label: 'On hand', key: 'on_hand', num: true }, { label: 'Last dispatch', key: 'last_dispatch' },
                 { label: 'Days idle', key: 'days_idle', num: true }],
        st.dead, function (row, k) {
          if (k === 'on_hand') return qty(row.on_hand);
          if (k === 'days_idle') return row.days_idle === null ? '—' : row.days_idle;
          return esc(String(row[k] == null ? '' : row[k]));
        }),
      'Stock sitting against no dispatch. Capital parked, and the first place to look before reordering anything else.') +

    section('Products', 'What is asked for, and what actually ships.') +
    '<div class="an-two">' +
      card2('Top requested by units', productBars(pr.top_by_units, qty)) +
      card2('Top requested by value', productBars(pr.top_by_value, inr)) +
    '</div>' +
    '<div class="an-two">' +
      card2('Top actually shipped', productBars(pr.top_by_shipped, qty),
        'Requested is intent. Shipped is revenue. A gap between the two lists is where orders are being lost.') +
      card2('Never requested · ' + pr.never_requested_total + ' of ' + pr.catalogue_size,
        dataTable([{ label: 'SKU', key: 'sku' }, { label: 'Product', key: 'name' },
                   { label: 'Category', key: 'category' }, { label: 'On hand', key: 'on_hand', num: true }],
          pr.never_requested, function (row, k) {
            return k === 'on_hand' ? qty(row.on_hand) : esc(String(row[k] == null ? '' : row[k]));
          })) +
    '</div>' +

    section('Customers', 'Where the value is concentrated.') +
    '<div class="stat-row">' +
      stat(qty(cu.count), 'Customers in window') +
      stat(cu.top3_share === null ? '—' : cu.top3_share + '%', 'Top 3 share of value') +
    '</div>' +
    ((cu.top3_share !== null && cu.top3_share > 70)
      ? '<div class="note2 warn"><strong>' + cu.top3_share + '% of value sits with three customers.</strong> Losing one would be felt.</div>'
      : '') +
    card2('Customers by value',
      dataTable([{ label: 'Company', key: 'company' }, { label: 'Requests', key: 'requests', num: true },
                 { label: 'Value', key: 'value', num: true }, { label: 'Share', key: 'share', num: true }],
        cu.top, function (row, k) {
          if (k === 'value') return inr(row.value);
          if (k === 'share') return row.share + '%';
          return esc(String(row[k] == null ? '' : row[k]));
        }));

  $('rangeChips').querySelectorAll('.chip').forEach(function (b) {
    b.onclick = function () { A.days = Number(b.dataset.d); loadAnalytics(); };
  });
}

/* ================= SETTINGS + STOCK SYNC ================= */
function loadSettings() {
  var need = A.brands.length ? Promise.resolve() : api('adminCatalog').then(function (res) { A.products = res.products; A.brands = res.brands; }).catch(function () {});
  need.then(renderSettings);
}

function renderSettings() {
  A.loaded.settings = true;
  var s = A.settings;
  $('p-settings').innerHTML =
    '<div class="panel-head"><h2>Site settings</h2></div>' +
    '<div class="two-col">' +
      '<div class="card-block"><h3>Identity</h3>' +
        '<div class="field"><label>Site name</label><input id="sName" value="' + esc(s.site_name) + '"></div>' +
        '<div class="field"><label>Tagline</label><input id="sTag" value="' + esc(s.tagline) + '"></div>' +
        '<div class="field"><label>Stock display</label><select id="sStock">' +
          '<option value="badge"' + (s.show_stock_numbers === 'badge' ? ' selected' : '') + '>Badge only (In / Low / Out)</option>' +
          '<option value="exact"' + (s.show_stock_numbers === 'exact' ? ' selected' : '') + '>Exact ATP numbers</option>' +
        '</select></div>' +
      '</div>' +
      '<div class="card-block"><h3>Operations</h3>' +
        '<div class="field"><label>New-enquiry notification email</label><input id="sNotify" value="' + esc(s.notify_email) + '" placeholder="you@company.com"></div>' +
        '<div class="field"><label>Low-stock badge threshold (ATP ≤)</label><input id="sLow" type="number" value="' + esc(s.low_stock_threshold) + '"></div>' +
        '<div class="field"><label>Sender name on notifications</label><input id="sFromName" value="' + esc(s.mail_from_name) + '" placeholder="' + esc(s.site_name) + '"></div>' +
        '<div class="field"><label>Stay signed in for</label><select id="sDays">' + [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, 'a year']].map(function (x) {
          return '<option value="' + x[0] + '"' + (String(s.session_days || '30') === String(x[0]) ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>' +
          '<div class="note" style="margin-top:4px">A sign-in survives reloads and reopens for this long. The console still locks after the inactivity time in the Company card.</div></div>' +
      '</div>' +
    '</div>' +
    '<div class="form-err" id="sErr"></div>' +
    '<button class="btn primary" id="sSave" style="margin:14px 0 10px">Save settings</button>' +
    renderCompanyCard(s) + renderDeckCard(s) + renderMailCard(s) + renderSyncCard(s);

  $('sSave').onclick = function () {
    $('sSave').disabled = true;
    api('adminSettings', { save: {
      site_name: $('sName').value.trim(), tagline: $('sTag').value.trim(),
      show_stock_numbers: $('sStock').value,
      notify_email: $('sNotify').value.trim(), low_stock_threshold: $('sLow').value,
      mail_from_name: $('sFromName').value.trim(), session_days: $('sDays').value
    } }).then(function (res) {
      A.settings = res.settings;
      $('sSave').disabled = false;
      toast('Settings saved');
    }).catch(function (e) { $('sErr').textContent = e.message; $('sSave').disabled = false; });
  };
  wireCompanyCard();
  wireDeckCard();
  wireMailCard();
  wireSyncCard();
}

/* Deck design: the colours and density every generated PDF and PPTX uses. */
var DECK_COLORS = [['deck_accent', 'Accent', 'Eyebrows, rules and the cover line', '#2447F5'], ['deck_ink', 'Text', 'Product names and body copy', '#1D1D1F'],
                   ['deck_muted', 'Muted text', 'SKU, headers, footers, table labels', '#6E6E73'], ['deck_plate', 'Image plate', 'Panel behind each product image', '#F5F5F7']];
function hexOk(v) { return /^#[0-9a-fA-F]{6}$/.test(String(v || '').trim()); }
function renderDeckCard(s) {
  return '<div class="card-block" style="margin-top:18px"><h3>Deck design</h3>' +
    '<p class="note-sub" style="margin:-4px 0 12px">Applies to every PDF and PowerPoint built from the Decks tab. Decks already built keep their look.</p>' +
    '<div class="two-col"><div>' +
      DECK_COLORS.map(function (c) {
        var v = hexOk(s[c[0]]) ? s[c[0]].toUpperCase() : c[3];
        return '<div class="field"><label>' + c[1] + ' <small style="font-weight:400;color:var(--ink-3)">· ' + c[2] + '</small></label>' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<input type="color" id="' + c[0] + '_pick" value="' + v + '" style="width:44px;height:38px;padding:2px;border:1px solid var(--line);border-radius:8px;background:#fff">' +
            '<input id="' + c[0] + '" value="' + v + '" maxlength="7" style="width:110px;font-family:ui-monospace,monospace"></div></div>';
      }).join('') +
      '<div class="field"><label>Layout</label><select id="deck_layout">' +
        '<option value="compact"' + (s.deck_layout !== 'spacious' ? ' selected' : '') + '>Compact: two products per page and per slide</option>' +
        '<option value="spacious"' + (s.deck_layout === 'spacious' ? ' selected' : '') + '>Spacious: one product per page and per slide</option></select></div>' +
      '<div class="form-err" id="dkErr"></div>' +
      '<button class="btn primary" id="dkSave">Save deck design</button> <button class="btn" id="dkReset">Reset to defaults</button>' +
    '</div><div><div class="field"><label>Preview</label><div id="dkPrev"></div></div></div></div></div>';
}
function wireDeckCard() {
  function vals() {
    var o = {};
    DECK_COLORS.forEach(function (c) { o[c[0]] = $(c[0]).value.trim(); });
    o.deck_layout = $('deck_layout').value;
    return o;
  }
  function preview() {
    var v = vals();
    var col = function (k, i) { return hexOk(v[k]) ? v[k] : DECK_COLORS[i][3]; };
    var accent = col('deck_accent', 0), ink = col('deck_ink', 1), muted = col('deck_muted', 2), plate = col('deck_plate', 3);
    var sample = A.products.filter(function (p) { return p.visible && p.images[0]; })[0];
    $('dkPrev').innerHTML =
      '<div style="border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:#fff;font-family:Arial,Helvetica,sans-serif;border-top:4px solid ' + accent + '">' +
        '<div style="display:flex;justify-content:space-between;font-size:9px;font-weight:700;letter-spacing:.08em;color:' + muted + ';border-bottom:1px solid #e5e5ea;padding-bottom:6px;margin-bottom:12px"><span>' + esc((A.settings.co_name || 'YOUR COMPANY').toUpperCase()) + '</span><span style="font-weight:400;letter-spacing:0">Deck name</span></div>' +
        '<div style="display:flex;gap:14px">' +
          '<div style="width:92px;height:92px;border-radius:8px;background:' + plate + ';display:flex;align-items:center;justify-content:center;flex:none">' + (sample ? '<img src="' + esc(sample.images[0]) + '" style="max-width:76px;max-height:76px">' : '') + '</div>' +
          '<div style="min-width:0"><div style="font-size:9px;font-weight:700;letter-spacing:.08em;color:' + accent + '">BRAND · CATEGORY</div>' +
            '<div style="font-size:17px;font-weight:700;color:' + ink + ';margin:3px 0 2px;line-height:1.1">' + esc(sample ? sample.name : 'Product name') + '</div>' +
            '<div style="font-size:10px;color:' + muted + ';margin-bottom:8px">' + esc(sample ? sample.sku : 'SKU-0001') + ' · HSN 7323</div>' +
            '<div style="font-size:11px;font-weight:700;color:' + ink + '">MOQ 25 · GST 18%</div>' +
            '<div style="font-size:11px;font-weight:700;color:#248a3d;margin-top:6px">In stock · 1,200 available</div></div></div>' +
        '<table style="border-collapse:collapse;margin-top:12px;width:100%"><tr>' + ['25+ units', '100+ units', '250+ units'].map(function (t) { return '<td style="font-size:9px;color:' + muted + ';border-bottom:1px solid ' + ink + ';padding-bottom:3px">' + t + '</td>'; }).join('') + '</tr>' +
        '<tr>' + ['₹879', '₹852', '₹824'].map(function (t) { return '<td style="font-size:14px;font-weight:700;color:' + ink + ';padding-top:4px">' + t + '</td>'; }).join('') + '</tr></table>' +
      '</div>';
  }
  DECK_COLORS.forEach(function (c) {
    $(c[0] + '_pick').oninput = function () { $(c[0]).value = this.value.toUpperCase(); preview(); };
    $(c[0]).oninput = function () { if (hexOk(this.value)) $(c[0] + '_pick').value = this.value; preview(); };
  });
  $('deck_layout').onchange = preview;
  preview();
  $('dkReset').onclick = function () {
    DECK_COLORS.forEach(function (c) { $(c[0]).value = c[3]; $(c[0] + '_pick').value = c[3]; });
    $('deck_layout').value = 'compact'; preview();
  };
  $('dkSave').onclick = function () {
    var v = vals();
    var bad = DECK_COLORS.filter(function (c) { return !hexOk(v[c[0]]); });
    if (bad.length) { $('dkErr').textContent = bad[0][1] + ' must be a six-digit hex colour like #2447F5'; return; }
    $('dkErr').textContent = ''; $('dkSave').disabled = true;
    api('adminSettings', { save: v }).then(function (res) { A.settings = res.settings; toast('Deck design saved'); })
      .catch(function (e) { $('dkErr').textContent = e.message; }).then(function () { $('dkSave').disabled = false; });
  };
}

/* The supplier's own identity: printed on every PI and, from phase 4, on every deck. */
function renderCompanyCard(s) {
  function f(id, label, val, extra) {
    return '<div class="field"><label>' + label + '</label><input id="' + id + '" value="' + esc(val || '') + '"' + (extra || '') + '></div>';
  }
  function picker(prevId, nameId, pickId, clearId, label, url, hint) {
    return '<div class="field"><label>' + label + '</label>' +
      '<div class="logo-picker"><div id="' + prevId + '" class="logo-prev' + (url ? '' : ' no-logo') + '">' +
        (url ? '<img src="' + esc(url) + '" alt="">' : '<span class="logo-none">None</span>') + '</div>' +
      '<div class="logo-picker-side"><div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<label class="btn small" for="' + pickId + '" style="cursor:pointer">' + (url ? 'Replace' : 'Choose image') + '</label>' +
        '<button type="button" class="btn small" id="' + clearId + '"' + (url ? '' : ' hidden') + '>Remove</button></div>' +
      '<div id="' + nameId + '" class="note logo-name">' + esc(hint) + '</div></div></div>' +
      '<input id="' + pickId + '" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" class="sr-only"></div>';
  }
  return '<div class="card-block" style="margin-top:10px"><h3>Company</h3>' +
    '<p class="note" style="margin-top:-4px">This is the issuer on every proforma invoice and the identity on generated decks. Keep it exactly as it should appear on a tax document.</p>' +
    '<div class="two-col">' +
      '<div>' +
        f('cName', 'Legal name', s.co_name) +
        f('cAddr', 'Registered address', s.co_address) +
        '<div class="f2">' + f('cState', 'State', s.co_state) + f('cStateCode', 'State code', s.co_state_code, ' maxlength="2" placeholder="29"') + '</div>' +
        '<div class="f2">' + f('cGstin', 'GSTIN', s.co_gstin, ' maxlength="15"') + f('cPan', 'PAN', s.co_pan, ' maxlength="10"') + '</div>' +
        '<div class="f2">' + f('cPhone', 'Phone', s.co_phone) + f('cEmail', 'Email', s.co_email) + '</div>' +
      '</div>' +
      '<div>' +
        picker('cLogoPrev', 'cLogoName', 'cLogoFile', 'cLogoClear', 'Logo', s.co_logo_url, 'PNG with a transparent background prints best.') +
        picker('cSignPrev', 'cSignName', 'cSignFile', 'cSignClear', 'Authorised signature', s.co_sign_url, 'Appears on the PI signature block.') +
        f('cBank', 'Bank details (as printed on the PI)', s.co_bank) +
        f('cTerms', 'Standard terms', s.co_terms) +
        '<div class="f2">' + f('cPiPrefix', 'PI number prefix', s.pi_prefix, ' placeholder="PI"') + f('cPiValid', 'PI validity (days)', s.pi_validity_days, ' type="number" min="1"') + '</div>' +
        '<div class="field"><label>Sign-out after inactivity</label><select id="cSession">' +
          [15, 30, 60, 120].map(function (m) { return '<option value="' + m + '"' + (String(s.session_minutes || 30) === String(m) ? ' selected' : '') + '>' + m + ' minutes</option>'; }).join('') +
        '</select></div>' +
      '</div>' +
    '</div>' +
    '<div class="form-err" id="cErr"></div>' +
    '<button class="btn primary" id="cSave" style="margin-top:8px">Save company</button></div>';
}

function wireCompanyCard() {
  var logo = A.settings.co_logo_url || '', sign = A.settings.co_sign_url || '';
  function bindPicker(fileId, prevId, nameId, clearId, get, set) {
    $(fileId).onchange = function () {
      var f = this.files[0]; if (!f) return;
      if (f.size > 4 * 1024 * 1024) { $('cErr').textContent = 'That file is over 4MB.'; return; }
      var rd = new FileReader();
      rd.onload = function () {
        $(nameId).textContent = 'Uploading ' + f.name + '…';
        $('cSave').disabled = true;
        api('adminImageUpload', { data: rd.result, filename: 'company-' + f.name, mime: f.type }).then(function (res) {
          set(res.url);
          $(prevId).className = 'logo-prev';
          $(prevId).innerHTML = '<img src="' + esc(res.url) + '" alt="">';
          $(clearId).hidden = false;
          $(nameId).textContent = f.name + ' — press Save company to keep it.';
          $('cSave').disabled = false;
        }).catch(function (e) { $('cErr').textContent = e.message; $('cSave').disabled = false; });
      };
      rd.readAsDataURL(f);
    };
    $(clearId).onclick = function () {
      set('');
      $(prevId).className = 'logo-prev no-logo';
      $(prevId).innerHTML = '<span class="logo-none">None</span>';
      $(clearId).hidden = true;
      $(nameId).textContent = 'Removed — press Save company to apply.';
    };
  }
  bindPicker('cLogoFile', 'cLogoPrev', 'cLogoName', 'cLogoClear', function () { return logo; }, function (v) { logo = v; });
  bindPicker('cSignFile', 'cSignPrev', 'cSignName', 'cSignClear', function () { return sign; }, function (v) { sign = v; });

  $('cSave').onclick = function () {
    var gstin = $('cGstin').value.trim().toUpperCase();
    if (gstin && gstin.length !== 15) { $('cErr').textContent = 'A GSTIN is 15 characters.'; return; }
    $('cSave').disabled = true; $('cErr').textContent = '';
    api('adminSettings', { save: {
      co_name: $('cName').value.trim(), co_address: $('cAddr').value.trim(),
      co_state: $('cState').value.trim(), co_state_code: $('cStateCode').value.trim(),
      co_gstin: gstin, co_pan: $('cPan').value.trim().toUpperCase(),
      co_phone: $('cPhone').value.trim(), co_email: $('cEmail').value.trim(),
      co_bank: $('cBank').value.trim(), co_terms: $('cTerms').value.trim(),
      co_logo_url: logo, co_sign_url: sign,
      pi_prefix: $('cPiPrefix').value.trim() || 'PI', pi_validity_days: $('cPiValid').value || '15',
      session_minutes: $('cSession').value
    } }).then(function (res) {
      A.settings = res.settings;
      A.sessionMinutes = Number(res.settings.session_minutes) || 30;
      armIdle();
      $('cSave').disabled = false;
      toast('Company saved');
    }).catch(function (e) { $('cErr').textContent = e.message; $('cSave').disabled = false; });
  };
}

/* Where notification email is sent from: our account, or the supplier's. */
function renderMailCard(s) {
  var relay = s.mail_mode === 'relay';
  var st = A.relayStatus;
  var stTxt = !st ? 'No relay send recorded yet.'
    : st.ok
      ? 'Last relay send ' + esc(String(st.ts).slice(4, 21)) + ' — delivered' +
        (st.remaining === null || st.remaining === undefined ? '' : ' · ' + st.remaining + ' left in their daily quota today')
      : '<span style="color:var(--bad)">Last relay send failed: ' + esc(st.error || '') + '</span> — that message went out from the Merchforce account instead.';
  return section('Notification email',
      'Who the supplier\'s notifications appear to come from. Sending through their own account needs a small relay script in their Google account — no password or token is shared with us.') +
    '<div class="panel2">' +
      '<div class="field"><label>Send from</label><select id="wMode">' +
        '<option value="backend"' + (relay ? '' : ' selected') + '>The Merchforce account (replies go to the buyer)</option>' +
        '<option value="relay"' + (relay ? ' selected' : '') + '>The supplier\'s own address (via their relay)</option>' +
      '</select></div>' +
      '<div id="wRelayBox"' + (relay ? '' : ' hidden') + '>' +
        '<div class="field"><label>Relay web-app URL</label><input id="wUrl" value="' + esc(s.relay_url) + '" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
        '<div class="field"><label>Shared secret</label>' +
          '<div style="display:flex;gap:8px"><input id="wSecret" value="' + esc(s.relay_secret) + '" placeholder="click Generate">' +
          '<button class="btn small" id="wGen" style="flex:none">Generate</button></div></div>' +
        '<p class="note" style="margin:0 0 10px">' + esc(stTxt).replace(/&lt;/g, '<').replace(/&gt;/g, '>') + '</p>' +
      '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
        '<button class="btn primary small" id="wSave">Save mail settings</button>' +
        '<button class="btn small" id="wScript">Get relay script</button>' +
        '<button class="btn small" id="wTest">Send test email</button>' +
        '<span id="wOut" style="font-size:13px;color:var(--ink-3)"></span>' +
      '</div>' +
    '</div>';
}

function wireMailCard() {
  $('wMode').onchange = function () { $('wRelayBox').hidden = this.value !== 'relay'; };
  $('wGen').onclick = function () {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    $('wSecret').value = 'mfr_' + Array.prototype.map.call(a, function (x) {
      return ('0' + x.toString(16)).slice(-2);
    }).join('');
  };
  $('wSave').onclick = function () {
    if ($('wMode').value === 'relay' && (!$('wUrl').value.trim() || !$('wSecret').value.trim())) {
      $('wOut').innerHTML = '<span style="color:var(--bad)">Relay needs both the URL and the secret.</span>';
      return;
    }
    $('wSave').disabled = true;
    api('adminSettings', { save: {
      mail_mode: $('wMode').value,
      relay_url: $('wUrl') ? $('wUrl').value.trim() : '',
      relay_secret: $('wSecret') ? $('wSecret').value.trim() : ''
    } }).then(function (res) {
      A.settings = res.settings;
      A.relayStatus = res.relay_status || null;
      $('wSave').disabled = false;
      toast('Mail settings saved');
      renderSettings();
    }).catch(function (e) { $('wOut').textContent = e.message; $('wSave').disabled = false; });
  };
  $('wTest').onclick = function () {
    $('wOut').textContent = 'Sending…';
    api('adminMailTest', {}).then(function (res) {
      A.relayStatus = res.status || A.relayStatus;
      $('wOut').innerHTML = 'Sent to ' + esc(res.to) + ' via <b>' + esc(res.via) + '</b>';
    }).catch(function (e) { $('wOut').innerHTML = '<span style="color:var(--bad)">' + esc(e.message) + '</span>'; });
  };
  $('wScript').onclick = openRelayScript;
}

/* The relay: a standalone Apps Script the supplier deploys in their own account. */
function openRelayScript() {
  var secret = ($('wSecret') && $('wSecret').value.trim()) || '(click Generate first)';
  var code =
"/** Merchforce mail relay — sends Merchforce notifications from THIS account. */\n" +
"var RELAY_SECRET = '" + secret + "';\n" +
"\n" +
"function doPost(e) {\n" +
"  var reply = function (o) {\n" +
"    return ContentService.createTextOutput(JSON.stringify(o))\n" +
"      .setMimeType(ContentService.MimeType.JSON);\n" +
"  };\n" +
"  var p;\n" +
"  try { p = JSON.parse(e.postData.contents); }\n" +
"  catch (err) { return reply({ ok: false, error: 'Bad JSON' }); }\n" +
"  if (String(p.secret) !== RELAY_SECRET) return reply({ ok: false, error: 'Bad secret' });\n" +
"  if (!p.to || !p.subject) return reply({ ok: false, error: 'to and subject required' });\n" +
"  try {\n" +
"    MailApp.sendEmail({\n" +
"      to: String(p.to),\n" +
"      subject: String(p.subject),\n" +
"      body: String(p.body || ''),\n" +
"      name: p.name ? String(p.name) : undefined,\n" +
"      replyTo: p.replyTo ? String(p.replyTo) : undefined\n" +
"    });\n" +
"    return reply({ ok: true, remaining: MailApp.getRemainingDailyQuota() });\n" +
"  } catch (err) {\n" +
"    return reply({ ok: false, error: String(err) });\n" +
"  }\n" +
"}";
  openDrawer(
    '<h2 style="margin:0 0 4px">Mail relay — send from the supplier\'s own address</h2>' +
    '<p class="note" style="margin:0 0 14px">This script lives in the <b>supplier\'s</b> Google account. Merchforce posts the message to it and their account does the sending, so the mail leaves their address on their own quota (100 recipients a day on a personal Gmail, 1,500 on Workspace). No password or token of theirs is shared with us, and deleting the deployment revokes it instantly.</p>' +
    '<ol style="margin:0 0 14px;padding-left:20px;font-size:14px;line-height:1.7">' +
      '<li>They open <b>script.google.com</b> → <b>New project</b> and paste the script below.</li>' +
      '<li><b>Deploy → New deployment → Web app</b>; "Execute as" <b>Me</b>, "Who has access" <b>Anyone</b>, then authorize.</li>' +
      '<li>They send you the <b>/exec</b> URL; paste it into the Relay web-app URL field with this same secret.</li>' +
      '<li>Hit <b>Send test email</b> to confirm it arrives from their address.</li>' +
    '</ol>' +
    '<p class="note">"Anyone" access is needed so our server can reach it — the shared secret is what authorizes each message, and the script can only send mail, nothing else. If the relay ever fails, Merchforce falls back to sending from its own account so nothing is lost.</p>' +
    '<textarea id="lsCode" readonly style="width:100%;height:300px;font-family:ui-monospace,monospace;font-size:12px;border:1px solid var(--line);border-radius:10px;padding:12px;white-space:pre"></textarea>' +
    '<button class="btn primary" id="lsCopy" style="width:100%;justify-content:center;margin-top:10px">Copy script</button>');
  $('lsCode').value = code;
  $('lsCopy').onclick = function () {
    $('lsCode').select();
    try { navigator.clipboard.writeText(code); } catch (e) { document.execCommand('copy'); }
    toast('Copied — the supplier pastes this into a new Apps Script project');
  };
}

var SYNC_FIELDS = [
  ['on_hand', 'Stock (on hand)'],
  ['price', 'Selling price (first tier)'],
  ['mrp', 'MRP'],
  ['moq', 'MOQ'],
  ['gst_rate', 'GST %'],
  ['hsn', 'HSN code'],
  ['name', 'Product name'],
  ['lead_time', 'Lead time'],
  ['description', 'Description'],
  ['category', 'Category'],
  ['subcategory', 'Subcategory']
];
function syncFieldLabel(f) {
  var hit = SYNC_FIELDS.filter(function (x) { return x[0] === f; })[0];
  return hit ? hit[1] : f;
}
function mapFieldsOf(m) {
  if (m.fields && m.fields.length) return m.fields;
  if (m.stock_col) return [{ col: m.stock_col, field: 'on_hand' }];
  return [];
}
/* A mapping can draw fields from several tabs of one workbook. */
function mapSourcesOf(m) {
  if (m.sources && m.sources.length) {
    return m.sources.filter(function (s) { return s.sku_col && (s.fields || []).length; });
  }
  var f = mapFieldsOf(m);
  if (!f.length || !m.sku_col) return [];
  return [{ tab: m.tab || '', sku_col: m.sku_col, fields: f }];
}

function renderSyncCard(s) {
  var maps = [];
  try { maps = JSON.parse(s.sync_maps || '[]'); } catch (e) {}
  var rows = maps.map(function (m, i) {
    var last = m.last;
    var lastTxt = !last ? '—'
      : last.error ? '<span style="color:var(--bad)">' + esc(last.error).slice(0, 60) + '</span>'
      : esc(String(last.ts).slice(4, 21)) + ' · ' + last.updated + ' updated' +
        (last.created ? ', ' + last.created + ' created' : '') +
        (last.unknown ? ', ' + last.unknown + ' unknown' : '') +
        (last.off_brand ? ', ' + last.off_brand + ' off-brand' : '');
    var srcs = mapSourcesOf(m);
    var fieldsTxt = srcs.map(function (src) {
      return '<b>' + esc(src.tab || 'first tab') + '</b> · ' + esc(src.sku_col) + ' → SKU<br>' +
        src.fields.map(function (f) {
          return '&nbsp;&nbsp;' + esc(f.col) + ' → ' + esc(syncFieldLabel(f.field));
        }).join('<br>');
    }).join('<br>');
    var push = m.mode === 'push';
    var mapped = srcs.length;
    return '<tr><td><b>' + esc(m.brand ? brandNameSafe(m.brand) : 'All brands') + '</b>' +
      '<br><span class="pill" style="font-size:10.5px;' + (push
        ? 'background:#f1e8ff;color:#7a3cf0">sheet pushes to us'
        : 'background:var(--accent-soft);color:var(--accent)">we read the sheet') + '</span>' +
      (m.create_new ? ' <span class="pill" style="background:var(--ok-soft);color:var(--ok);font-size:10.5px">auto-creates new</span>' : '') +
      (!push && m.write_back ? ' <span class="pill" style="background:var(--ok-soft);color:var(--ok);font-size:10.5px" title="Stock movements in the app are written into this sheet">writes stock back</span>' : '') +
      (!push && m.write_back && m.write_back_last && m.write_back_last.error ? '<br><small style="color:var(--bad)">write-back failed: ' + esc(m.write_back_last.error) + '</small>' : '') + '</td>' +
      '<td style="font-size:12px;color:var(--ink-3)">' +
        (push ? (mapped ? srcs.length + ' tab' + (srcs.length === 1 ? '' : 's') : 'sheet') + '<br>(private to supplier)'
              : '…' + esc(String(m.sheet).slice(-8))) + '</td>' +
      '<td style="font-size:12.5px">' + (mapped
        ? fieldsTxt
        : '<span style="color:var(--warn);font-weight:700">' + ((m.tabs_meta || m.headers) ? 'columns received — map them' : 'awaiting first push') + '</span>') + '</td>' +
      '<td style="font-size:12.5px">' + lastTxt + '</td>' +
      '<td style="white-space:nowrap">' +
      (push ? '<button class="btn small" data-conn="' + i + '">Connector</button> '
            : '<button class="btn small" data-sync="' + i + '">Sync</button> ') +
      '<button class="btn ghost small" data-edit="' + i + '">Edit</button> ' +
      '<button class="btn ghost small" data-del="' + i + '" style="color:var(--bad)">✕</button></td></tr>';
  }).join('');
  return section('Sheet sync — per brand',
      'The supplier keeps managing their catalog in their own Google Sheets, one per brand (like the Wenger stock sheet). ' +
      'Map any sheet column to any product field; a brand mapping only ever touches that brand\'s products.') +
    '<div class="panel2">' +
      (maps.length
        ? '<div class="tbl-wrap" style="margin-bottom:14px"><table class="tbl"><thead><tr>' +
          '<th>Brand</th><th>Sheet</th><th>Mapping</th><th>Last sync</th><th></th>' +
          '</tr></thead><tbody id="yRows">' + rows + '</tbody></table></div>'
        : '<p class="note">No sheets linked yet. Add the first brand mapping, or generate a ready-made template the supplier can copy and maintain.</p>') +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<button class="btn primary small" id="yAdd">+ Add brand mapping</button>' +
        (maps.length > 1 ? '<button class="btn small" id="ySyncAll">Sync all now</button>' : '') +
        '<button class="btn small" id="yWriteAll" title="Write every product\'s on hand into the linked sheets now">Write stock back now</button>' +
        '<button class="btn small" id="yLive">⚡ Instant sync setup</button>' +
        '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:13.5px;margin-left:auto">Auto-sync' +
          '<select id="yAuto" style="padding:6px 10px;border:1px solid var(--line);border-radius:8px">' +
            '<option value="off"' + (s.sync_auto === 'off' || !s.sync_auto ? ' selected' : '') + '>Off — manual only</option>' +
            '<option value="live5"' + (s.sync_auto === 'live5' ? ' selected' : '') + '>Near-live (every 5 min)</option>' +
            '<option value="hourly"' + (s.sync_auto === 'hourly' ? ' selected' : '') + '>Every hour</option>' +
            '<option value="daily"' + (s.sync_auto === 'daily' ? ' selected' : '') + '>Daily (~6 am)</option>' +
          '</select></label>' +
      '</div>' +
      '<div class="card-block" style="margin-top:16px"><h3>Standard format for a supplier without a usable sheet</h3>' +
        '<p class="note-sub" style="margin:-4px 0 12px">Creates a Google Sheet in the Merchforce Drive folder in the Merchforce format (Code · Product Name · HSN · GST % · MRP · Selling Price Excluding GST · Stock · MOQ · Lead Time), one tab per brand, pre-filled from the catalogue, with a How to use tab. ' +
          'Linked as a pull mapping with write-back on, so the sheet and the console show the same stock from the first day.</p>' +
        '<div class="f2">' +
          '<div class="field"><label>Share with (supplier\'s Google account, optional)</label><input id="yTplEmail" type="email" placeholder="stock@supplier.com"></div>' +
          '<div class="field"><label>Brands</label><select id="yTplBrand"><option value="">All brands, one tab each</option>' + A.brands.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.name) + ' only</option>'; }).join('') + '</select></div>' +
        '</div>' +
        '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:13.5px;margin-bottom:10px"><input type="checkbox" id="yTplLink" checked> Link it now (replaces any existing pull mapping for those brands)</label>' +
        '<button class="btn primary small" id="yTemplate">Create the sheet</button>' +
        '<p class="note" id="yTplOut" style="margin-top:10px"></p></div>' +
    '</div>';
}

function brandNameSafe(id) {
  var b = A.brands.filter(function (x) { return x.id === id; })[0];
  return b ? b.name : id;
}

function refreshSettings_() {
  return api('adminSettings', {}).then(function (res) {
    A.settings = res.settings;
    A.relayStatus = res.relay_status || A.relayStatus;
    renderSettings();
  });
}

function wireSyncCard() {
  var ensureBrands = A.brands.length ? Promise.resolve() : api('adminCatalog').then(function (res) {
    A.products = res.products; A.brands = res.brands;
  });

  $('yAdd').onclick = function () {
    ensureBrands.then(function () { openMapEditor(null, null); });
  };
  var syncAll = $('ySyncAll');
  if (syncAll) {
    syncAll.onclick = function () {
      syncAll.disabled = true; syncAll.textContent = 'Syncing…';
      api('adminSyncRun', {}).then(function (res) {
        var tot = res.results.reduce(function (s, r) { return s + (r.summary.updated || 0) + (r.summary.created || 0); }, 0);
        toast(tot + ' products touched across ' + res.results.length + ' sheets');
        return refreshSettings_();
      }).catch(function (e) { toast(e.message); syncAll.disabled = false; syncAll.textContent = 'Sync all now'; });
    };
  }
  $('yTemplate').onclick = function () {
    var email = $('yTplEmail').value.trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $('yTplOut').textContent = 'That email does not look right.'; return; }
    $('yTemplate').disabled = true;
    $('yTplOut').textContent = 'Building the sheet…';
    api('adminSyncTemplate', { editor_email: email, brand: $('yTplBrand').value, link: $('yTplLink').checked }).then(function (res) {
      $('yTemplate').disabled = false;
      if (res.maps) A.settings.sync_maps = JSON.stringify(res.maps);
      $('yTplOut').innerHTML = 'Ready: <a href="' + esc(res.url) + '" target="_blank">' + esc(res.name) + ' ↗</a>' +
        (res.shared ? ' · shared with ' + esc(res.shared) + ' as editor' : ' · view-only link; share it with the supplier from Drive') +
        (res.linked ? ' · ' + res.linked + ' brand mapping' + (res.linked === 1 ? '' : 's') + ' linked with write-back on.' : '.');
      if (res.linked) toast('Sheet created and linked'); else toast('Sheet created');
      if (res.linked) setTimeout(renderSettings, 1200);
    }).catch(function (e) { $('yTemplate').disabled = false; $('yTplOut').textContent = e.message; });
  };
  if ($('yWriteAll')) $('yWriteAll').onclick = function () {
    $('yWriteAll').disabled = true;
    api('adminSyncWriteBackAll').then(function (res) {
      toast(res.written + ' stock cell' + (res.written === 1 ? '' : 's') + ' written' + (res.errors.length ? ' · ' + res.errors[0] : ''));
      return refreshSettings_();
    }).catch(function (e) { toast(e.message); }).then(function () { if ($('yWriteAll')) $('yWriteAll').disabled = false; });
  };
  $('yLive').onclick = openLiveSyncHelp;
  var auto = $('yAuto');
  if (auto) {
    auto.onchange = function () {
      var prev = A.settings.sync_auto || 'off';
      api('adminSyncSchedule', { mode: auto.value })
        .then(function (res) {
          A.settings.sync_auto = res.mode;
          var msg = { off: 'Auto-sync off', live5: 'Near-live — pulls every 5 minutes',
                      hourly: 'Auto-sync every hour', daily: 'Auto-sync daily around 6 am' };
          toast(msg[res.mode]);
        })
        .catch(function (e) { toast(e.message); auto.value = prev; });
    };
  }
  var tb = $('yRows');
  if (tb) {
    tb.querySelectorAll('button[data-sync]').forEach(function (b) {
      b.onclick = function () {
        b.disabled = true; b.textContent = '…';
        api('adminSyncRun', { index: Number(b.dataset.sync) }).then(function (res) {
          var s = res.results[0].summary;
          toast(s.error ? s.error : s.updated + ' updated, ' + s.created + ' created, ' + s.unknown + ' unknown');
          return refreshSettings_();
        }).catch(function (e) { toast(e.message); b.disabled = false; b.textContent = 'Sync'; });
      };
    });
    tb.querySelectorAll('button[data-conn]').forEach(function (b) {
      b.onclick = function () {
        var maps = JSON.parse(A.settings.sync_maps || '[]');
        openPushConnector(maps[Number(b.dataset.conn)]);
      };
    });
    tb.querySelectorAll('button[data-edit]').forEach(function (b) {
      b.onclick = function () {
        var maps = JSON.parse(A.settings.sync_maps || '[]');
        ensureBrands.then(function () { openMapEditor(maps[Number(b.dataset.edit)], Number(b.dataset.edit)); });
      };
    });
    tb.querySelectorAll('button[data-del]').forEach(function (b) {
      b.onclick = function () {
        api('adminSyncMapDelete', { index: Number(b.dataset.del) })
          .then(refreshSettings_).catch(function (e) { toast(e.message); });
      };
    });
  }
}

/* Add/edit one brand→sheet mapping.
   Modes: pull (Merchforce reads the sheet) | push (the sheet sends to us).
   A mapping may draw fields from several TABS of the same workbook, each with
   its own SKU column — stock from one tab, prices and names from another. */
function openMapEditor(m, index) {
  var isNew = !m;
  m = m || { mode: 'pull', brand: '', sheet: '', tab: '', sku_col: '', fields: [], sources: [], create_new: false };
  var mode = m.mode === 'push' ? 'push' : 'pull';
  var draft = { sources: JSON.parse(JSON.stringify(mapSourcesOf(m))) };
  if (!draft.sources.length) draft.sources = [{ tab: m.tab || '', sku_col: '', fields: [{ col: '', field: 'on_hand' }] }];
  // What we know about the workbook: pull → after Load sheet; push → after the
  // supplier's first push. Either way: [{name, headers, sample, rows}].
  var tabsMeta = m.tabs_meta || (m.headers ? [{ name: m.tab || '', headers: m.headers, sample: m.sample || [], rows: 0 }] : null);

  openDrawer(
    '<h2 style="margin:0 0 4px">' + (isNew ? 'Link a brand sheet' : 'Edit mapping') + '</h2>' +
    '<div class="field"><label>How the data moves</label><select id="zMode">' +
      '<option value="pull"' + (mode === 'pull' ? ' selected' : '') + '>Merchforce reads the sheet — supplier shares it (Viewer)</option>' +
      '<option value="push"' + (mode === 'push' ? ' selected' : '') + '>The sheet sends to Merchforce — nothing shared, stays private</option>' +
    '</select></div>' +
    '<p class="note" id="zModeNote" style="margin:-4px 0 14px"></p>' +
    '<div class="field"><label>Brand</label><select id="zBrand">' +
      '<option value=""' + (m.brand ? '' : ' selected') + '>All brands (no restriction)</option>' +
      A.brands.map(function (b) {
        return '<option value="' + esc(b.id) + '"' + (b.id === m.brand ? ' selected' : '') + '>' + esc(b.name) + '</option>';
      }).join('') + '</select></div>' +
    '<div id="zPullBox">' +
      '<div class="field"><label>Sheet link or ID *</label><input id="zSheet" value="' + esc(m.sheet) + '" placeholder="https://docs.google.com/spreadsheets/d/…"></div>' +
      '<button class="btn small" id="zLoad">Load sheet</button> ' +
      '<span id="zStatus" style="font-size:13px;color:var(--ink-3)"></span>' +
    '</div>' +
    '<div id="zMap" style="margin-top:16px"></div>' +
    '<label style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:13.5px;margin-top:14px">' +
      '<input type="checkbox" id="zCreate"' + (m.create_new ? ' checked' : '') + '> Auto-create products for new SKUs in this sheet' +
    '</label>' +
    '<label id="zWbWrap" style="display:flex;gap:8px;align-items:center;font-weight:700;font-size:13.5px;margin-top:10px"' + (mode === 'push' ? ' hidden' : '') + '>' +
      '<input type="checkbox" id="zWriteBack"' + (m.write_back !== false ? ' checked' : '') + '> Write stock back to this sheet' +
    '</label>' +
    '<p class="note" style="margin:4px 0 0">Every order, dispatch, receipt and manual adjustment in the console updates the Stock column in the sheet, so the sheet never undoes the app\'s movements on the next sync. Needs Editor access to the sheet and a Stock column in the mapping. Not available for push mappings.</p>' +
    '<p class="note" style="margin:4px 0 0">New products are created hidden (not on the storefront) under this mapping\'s brand, so you can review and publish them from the Catalog tab. Needs a specific brand selected.</p>' +
    '<div class="form-err" id="mErr"></div>' +
    '<button class="btn primary" id="zSave" style="width:100%;justify-content:center;margin-top:10px">Save mapping</button>');

  function tabNames() { return (tabsMeta || []).map(function (t) { return t.name; }); }
  function headersFor(tab) {
    if (!tabsMeta) return null;
    var hit = tabsMeta.filter(function (t) { return t.name === tab; })[0] || (tab ? null : tabsMeta[0]);
    return hit ? hit.headers : null;
  }
  function sampleFor(tab) {
    if (!tabsMeta) return null;
    var hit = tabsMeta.filter(function (t) { return t.name === tab; })[0] || (tab ? null : tabsMeta[0]);
    return hit ? { headers: hit.headers, sample: hit.sample || [], rows: hit.rows } : null;
  }
  function colField(attr, tab, val) {
    var hs = headersFor(tab);
    if (!hs) return '<input ' + attr + ' value="' + esc(val || '') + '" placeholder="Column header" style="padding:7px 9px;border:1px solid var(--line);border-radius:8px;width:180px">';
    return '<select ' + attr + ' style="padding:7px 9px;border:1px solid var(--line);border-radius:8px;max-width:200px"><option value="">—</option>' +
      hs.map(function (h) { return '<option' + (h === val ? ' selected' : '') + '>' + esc(h) + '</option>'; }).join('') + '</select>';
  }

  function paintMap() {
    var box = $('zMap');
    var waiting = ($('zMode').value === 'push' && !tabsMeta);
    var html = '';
    if (waiting) {
      html += '<div class="note2">Save this mapping first and install the connector on the supplier\'s sheet — every tab and column it finds appears here automatically, then you map them. You can also type them now if you already know them.</div>';
    }
    html += '<label style="font-size:12.5px;font-weight:700;color:var(--ink-2)">Where the data comes from</label>' +
      '<p class="note" style="margin:2px 0 10px">One block per tab. Fields can come from different tabs of the same workbook — they are joined on each tab\'s SKU column.</p>';

    draft.sources.forEach(function (src, si) {
      var s = sampleFor(src.tab);
      html += '<div class="panel2" style="padding:14px 16px;margin-bottom:10px">' +
        '<div class="tier-row" style="margin-bottom:10px">' +
          'Tab ' + (tabsMeta
            ? '<select data-zt="' + si + '" style="padding:7px 9px;border:1px solid var(--line);border-radius:8px;max-width:200px">' +
              tabNames().map(function (n) {
                return '<option' + (n === src.tab ? ' selected' : '') + '>' + esc(n) + '</option>';
              }).join('') + '</select>'
            : '<input data-zt="' + si + '" value="' + esc(src.tab) + '" placeholder="Tab name (blank = first)" style="padding:7px 9px;border:1px solid var(--line);border-radius:8px;width:180px">') +
          ' &nbsp;SKU column ' + colField('data-zs="' + si + '"', src.tab, src.sku_col) +
          (draft.sources.length > 1
            ? ' <button type="button" class="btn ghost small" data-zsrm="' + si + '" style="color:var(--bad);margin-left:auto">Remove tab</button>' : '') +
        '</div>';
      src.fields.forEach(function (f, fi) {
        html += '<div class="tier-row">' + colField('data-zc="' + si + '.' + fi + '"', src.tab, f.col) +
          ' → <select data-zf="' + si + '.' + fi + '" style="padding:7px 9px;border:1px solid var(--line);border-radius:8px">' +
          SYNC_FIELDS.map(function (x) {
            return '<option value="' + x[0] + '"' + (x[0] === f.field ? ' selected' : '') + '>' + x[1] + '</option>';
          }).join('') + '</select>' +
          ' <button type="button" class="btn ghost small" data-zrm="' + si + '.' + fi + '"' + (src.fields.length === 1 ? ' disabled' : '') + '>✕</button></div>';
      });
      html += '<button type="button" class="btn small" data-zadd="' + si + '">+ Map another field from this tab</button>';
      if (s && s.sample.length) {
        html += '<div class="tbl-wrap" style="max-height:130px;overflow:auto;margin-top:10px"><table class="tbl"><thead><tr>' +
          s.headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
          s.sample.map(function (row) {
            return '<tr>' + row.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table></div>';
      }
      html += '</div>';
    });
    html += '<button type="button" class="btn small" id="zAddTab">+ Add a tab</button>';
    box.innerHTML = html;

    box.querySelectorAll('[data-zt]').forEach(function (elx) {
      elx.onchange = function () {
        var src = draft.sources[Number(elx.dataset.zt)];
        src.tab = elx.value;
        src.sku_col = '';
        src.fields.forEach(function (f) { f.col = ''; });
        guessSource(src);
        paintMap();
      };
    });
    box.querySelectorAll('[data-zs]').forEach(function (elx) {
      elx.onchange = function () { draft.sources[Number(elx.dataset.zs)].sku_col = elx.value; };
    });
    box.querySelectorAll('[data-zc]').forEach(function (elx) {
      elx.onchange = function () {
        var p = elx.dataset.zc.split('.');
        draft.sources[Number(p[0])].fields[Number(p[1])].col = elx.value;
      };
    });
    box.querySelectorAll('select[data-zf]').forEach(function (elx) {
      elx.onchange = function () {
        var p = elx.dataset.zf.split('.');
        draft.sources[Number(p[0])].fields[Number(p[1])].field = elx.value;
      };
    });
    box.querySelectorAll('button[data-zrm]').forEach(function (b) {
      b.onclick = function () {
        var p = b.dataset.zrm.split('.');
        draft.sources[Number(p[0])].fields.splice(Number(p[1]), 1);
        paintMap();
      };
    });
    box.querySelectorAll('button[data-zsrm]').forEach(function (b) {
      b.onclick = function () { draft.sources.splice(Number(b.dataset.zsrm), 1); paintMap(); };
    });
    box.querySelectorAll('button[data-zadd]').forEach(function (b) {
      b.onclick = function () {
        var src = draft.sources[Number(b.dataset.zadd)];
        var used = allUsedFields();
        var next = SYNC_FIELDS.filter(function (x) { return used.indexOf(x[0]) < 0; })[0];
        src.fields.push({ col: '', field: next ? next[0] : 'on_hand' });
        paintMap();
      };
    });
    $('zAddTab').onclick = function () {
      var names = tabNames();
      var used = draft.sources.map(function (s2) { return s2.tab; });
      var free = names.filter(function (n) { return used.indexOf(n) < 0; })[0];
      var usedF = allUsedFields();
      var nextF = SYNC_FIELDS.filter(function (x) { return usedF.indexOf(x[0]) < 0; })[0];
      var src = { tab: free !== undefined ? free : '', sku_col: '', fields: [{ col: '', field: nextF ? nextF[0] : 'on_hand' }] };
      guessSource(src);
      draft.sources.push(src);
      paintMap();
    };
  }

  function allUsedFields() {
    var out = [];
    draft.sources.forEach(function (s2) { s2.fields.forEach(function (f) { out.push(f.field); }); });
    return out;
  }

  var GUESS = { on_hand: ['stock', 'qty', 'quantity', 'on hand', 'available'],
                price: ['selling', 'dp ', 'price'], mrp: ['mrp'], name: ['name', 'product'],
                moq: ['moq'], gst_rate: ['gst'], hsn: ['hsn'], lead_time: ['lead'], description: ['desc'],
                category: ['category'], subcategory: ['subcat'] };
  function guessSource(src) {
    var hs = headersFor(src.tab);
    if (!hs) return;
    var pick = function (cur, words) {
      if (cur) return cur;
      return hs.filter(function (h) {
        return words.some(function (w) { return h.toLowerCase().indexOf(w) >= 0; });
      })[0] || '';
    };
    src.sku_col = pick(src.sku_col, ['sku', 'code', 'item']);
    src.fields.forEach(function (f) { f.col = pick(f.col, GUESS[f.field] || []); });
  }

  function paintMode() {
    var push = $('zMode').value === 'push';
    $('zPullBox').hidden = push;
    $('zWbWrap').hidden = push;
    $('zModeNote').innerHTML = push
      ? 'For suppliers who will not share their file. A small connector runs on <b>their</b> sheet and sends only the columns you map here — Merchforce never opens the file. You get the connector script right after saving.'
      : 'Merchforce opens the sheet directly. The supplier shares it with the backend account: Viewer to read, <b>Editor</b> if stock is to be written back.';
    $('zSave').textContent = push ? 'Save mapping & get connector' : 'Save mapping & sync now';
    paintMap();
  }
  $('zMode').onchange = paintMode;
  if (tabsMeta) draft.sources.forEach(guessSource);
  paintMode();

  $('zLoad').onclick = function () {
    $('zStatus').textContent = 'Opening sheet…';
    api('adminSyncPreview', { sheet: $('zSheet').value.trim(), tab: '' })
      .then(function (res) {
        tabsMeta = (res.all_tabs && res.all_tabs.length)
          ? res.all_tabs
          : [{ name: res.tab, headers: res.headers, sample: res.sample, rows: res.rows }];
        $('zStatus').textContent = tabsMeta.length + ' tab' + (tabsMeta.length === 1 ? '' : 's') + ': ' +
          tabsMeta.map(function (t) { return t.name + ' (' + t.rows + ')'; }).join(', ');
        draft.sources.forEach(function (src) {
          if (!src.tab && tabsMeta.length) src.tab = tabsMeta[0].name;
          guessSource(src);
        });
        paintMap();
      })
      .catch(function (e) { $('zStatus').innerHTML = '<span style="color:var(--bad)">' + esc(e.message) + '</span>'; });
  };

  $('zSave').onclick = function () {
    var push = $('zMode').value === 'push';
    var sources = draft.sources.map(function (s2) {
      return { tab: s2.tab || '', sku_col: s2.sku_col || '',
               fields: (s2.fields || []).filter(function (f) { return f.col; }) };
    }).filter(function (s2) { return s2.sku_col && s2.fields.length; });
    if (!push && !sources.length) {
      $('mErr').textContent = 'Each tab needs its SKU column and at least one field mapping.'; return;
    }
    if (push && !$('zBrand').value) { $('mErr').textContent = 'A push mapping must be bound to one brand.'; return; }
    if ($('zCreate').checked && !$('zBrand').value) { $('mErr').textContent = 'Auto-create needs a specific brand selected.'; return; }
    $('zSave').disabled = true;
    var payload = { map: { mode: push ? 'push' : 'pull', brand: $('zBrand').value,
                           sheet: push ? '' : $('zSheet').value.trim(),
                           tab: sources[0] ? sources[0].tab : '',
                           sku_col: sources[0] ? sources[0].sku_col : '',
                           fields: sources[0] ? sources[0].fields : [],
                           sources: sources, create_new: $('zCreate').checked, write_back: !push && $('zWriteBack').checked } };
    if (index !== null && index !== undefined) payload.index = index;
    api('adminSyncMapSave', payload).then(function (res) {
      var idx = (index !== null && index !== undefined) ? index : res.maps.length - 1;
      if (push) {
        A.settings.sync_maps = JSON.stringify(res.maps);
        closeDrawer();
        renderSettings();
        openPushConnector(res.maps[idx]);
        return null;
      }
      return api('adminSyncRun', { index: idx }).then(function (r2) {
        var s2 = r2.results[0].summary;
        toast(s2.error ? s2.error : 'Synced: ' + s2.updated + ' updated, ' + s2.created + ' created, ' + s2.unknown + ' unknown');
        closeDrawer();
        return refreshSettings_();
      });
    }).catch(function (e) { $('mErr').textContent = e.message; $('zSave').disabled = false; });
  };
}

/* The push connector: runs on the supplier's own sheet, sends only mapped columns. */
function openPushConnector(m) {
  var code =
"/** Merchforce connector — this sheet stays private; only the mapped columns are sent. */\n" +
"var MERCHFORCE_URL = '" + CONFIG.API_URL + "';\n" +
"var MERCHFORCE_TOKEN = '" + CONFIG.API_TOKEN + "';\n" +
"var PUSH_KEY = '" + (m.push_key || '') + "';\n" +
"var TABS = [];   // empty = every tab in this sheet; or e.g. ['Stock','Price List']\n" +
"\n" +
"function install() {\n" +
"  ScriptApp.getProjectTriggers().forEach(function (t) {\n" +
"    var f = t.getHandlerFunction();\n" +
"    if (f === 'merchforceOnEdit' || f === 'merchforceHourly') ScriptApp.deleteTrigger(t);\n" +
"  });\n" +
"  ScriptApp.newTrigger('merchforceOnEdit')\n" +
"    .forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();\n" +
"  ScriptApp.newTrigger('merchforceHourly').timeBased().everyHours(1).create();\n" +
"  merchforceSend();\n" +
"}\n" +
"\n" +
"function merchforceOnEdit(e) {\n" +
"  var cache = CacheService.getScriptCache();\n" +
"  if (cache.get('mf_recent')) return;   // at most one send per 30s while editing\n" +
"  cache.put('mf_recent', '1', 30);\n" +
"  merchforceSend();\n" +
"}\n" +
"\n" +
"function merchforceHourly() { merchforceSend(); }\n" +
"\n" +
"function merchforceSend() {\n" +
"  var tabs = [];\n" +
"  SpreadsheetApp.getActive().getSheets().forEach(function (sh) {\n" +
"    if (TABS.length && TABS.indexOf(sh.getName()) < 0) return;\n" +
"    var lr = sh.getLastRow(), lc = sh.getLastColumn();\n" +
"    if (lr < 1 || lc < 1) return;\n" +
"    var values = sh.getRange(1, 1, Math.min(lr, 2001), lc).getValues();\n" +
"    var headers = values.shift();\n" +
"    tabs.push({ name: sh.getName(), headers: headers, rows: values });\n" +
"  });\n" +
"  if (!tabs.length) return;\n" +
"  var res = UrlFetchApp.fetch(MERCHFORCE_URL, {\n" +
"    method: 'post', contentType: 'text/plain', muteHttpExceptions: true,\n" +
"    payload: JSON.stringify({ action: 'syncPush', token: MERCHFORCE_TOKEN,\n" +
"                              push_key: PUSH_KEY, tabs: tabs })\n" +
"  });\n" +
"  Logger.log(res.getContentText());\n" +
"}";
  openDrawer(
    '<h2 style="margin:0 0 4px">Connector for ' + esc(m.brand ? brandNameSafe(m.brand) : 'this sheet') + '</h2>' +
    '<p class="note" style="margin:0 0 14px">The supplier keeps their file entirely private — this script runs inside <b>their</b> sheet, under their own Google account, and sends only the columns mapped here. Merchforce never opens the file and needs no access to it.</p>' +
    '<ol style="margin:0 0 14px;padding-left:20px;font-size:14px;line-height:1.7">' +
      '<li>The supplier opens their sheet → <b>Extensions → Apps Script</b>.</li>' +
      '<li>They replace whatever is in the editor with the script below.</li>' +
      '<li>Save, choose the <b>install</b> function, click <b>Run</b>, approve the authorization (it is their own script, on their own file).</li>' +
      '<li>The first run sends every tab\'s column names here — then map them in this console (fields may come from different tabs).</li>' +
    '</ol>' +
    '<p class="note">After that it sends on every edit (max once per 30 seconds) plus hourly as a safety net. The push key below identifies this mapping — treat it like a password.</p>' +
    '<textarea id="lsCode" readonly style="width:100%;height:300px;font-family:ui-monospace,monospace;font-size:12px;border:1px solid var(--line);border-radius:10px;padding:12px;white-space:pre"></textarea>' +
    '<button class="btn primary" id="lsCopy" style="width:100%;justify-content:center;margin-top:10px">Copy script</button>');
  $('lsCode').value = code;
  $('lsCopy').onclick = function () {
    $('lsCode').select();
    try { navigator.clipboard.writeText(code); } catch (e) { document.execCommand('copy'); }
    toast('Copied — the supplier pastes this into Extensions → Apps Script');
  };
}

/* Instant (edit-triggered) sync: connector script for the supplier's sheet. */
function openLiveSyncHelp() {
  var code =
"/** Merchforce live-sync connector — lives on the supplier's stock sheet. */\n" +
"var MERCHFORCE_URL = '" + CONFIG.API_URL + "';\n" +
"var MERCHFORCE_TOKEN = '" + CONFIG.API_TOKEN + "';\n" +
"\n" +
"function install() {\n" +
"  ScriptApp.getProjectTriggers().forEach(function (t) {\n" +
"    if (t.getHandlerFunction() === 'merchforcePing') ScriptApp.deleteTrigger(t);\n" +
"  });\n" +
"  ScriptApp.newTrigger('merchforcePing')\n" +
"    .forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();\n" +
"}\n" +
"\n" +
"function merchforcePing(e) {\n" +
"  UrlFetchApp.fetch(MERCHFORCE_URL, {\n" +
"    method: 'post', contentType: 'text/plain', muteHttpExceptions: true,\n" +
"    payload: JSON.stringify({ action: 'syncPing', token: MERCHFORCE_TOKEN,\n" +
"                              sheet: SpreadsheetApp.getActive().getId() })\n" +
"  });\n" +
"}";
  openDrawer(
    '<h2 style="margin:0 0 4px">⚡ Instant sync</h2>' +
    '<p class="note" style="margin:0 0 14px">Google Sheets cannot push changes out by itself, so instant sync works by installing this tiny connector ON the supplier\'s sheet. The moment anyone edits a cell, it pings Merchforce and the mapped fields are pulled within seconds (pings are debounced to one per 45 seconds per sheet).</p>' +
    '<ol style="margin:0 0 14px;padding-left:20px;font-size:14px;line-height:1.7">' +
      '<li>Open the supplier\'s stock sheet (anyone with <b>edit</b> access can do this — you or the supplier).</li>' +
      '<li>Menu: <b>Extensions → Apps Script</b>.</li>' +
      '<li>Delete whatever is in the editor and paste the script below.</li>' +
      '<li>Save, pick the <b>install</b> function in the toolbar, click <b>Run</b>, and approve the authorization.</li>' +
    '</ol>' +
    '<p class="note">Done once per sheet. The sheet must already be linked as a mapping here, or pings are ignored. Keep a scheduled auto-sync on as a safety net.</p>' +
    '<textarea id="lsCode" readonly style="width:100%;height:280px;font-family:ui-monospace,monospace;font-size:12px;border:1px solid var(--line);border-radius:10px;padding:12px;white-space:pre"></textarea>' +
    '<button class="btn primary" id="lsCopy" style="width:100%;justify-content:center;margin-top:10px">Copy script</button>');
  $('lsCode').value = code;
  $('lsCopy').onclick = function () {
    $('lsCode').select();
    try { navigator.clipboard.writeText(code); } catch (e) { document.execCommand('copy'); }
    toast('Copied — paste it into Extensions → Apps Script on the sheet');
  };
}

/* ---------- drawer ---------- */
function openDrawer(html) {
  $('mBody').innerHTML = html;
  $('mOverlay').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  $('mOverlay').hidden = true;
  document.body.style.overflow = '';
}
$('mClose').onclick = closeDrawer;
$('mOverlay').addEventListener('click', function (e) { if (e.target === this) closeDrawer(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
