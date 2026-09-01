/* Merchforce — the client's own order page, opened from the link in their email. */
'use strict';

var CONFIG = {
  API_URL: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? '/api' : 'https://script.google.com/macros/s/AKfycbxrQDSF3on09dWcD9Ct6Buge9k4h0kTZi13NQ_QyF7pGO3IX7ZCrrXGanyuIhYNAl-gyA/exec',
  API_TOKEN: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'mf-demo-token' : ''
};

var TOKEN = new URLSearchParams(location.search).get('t') || '';
var O = null;

var STAGES = ['New', 'Accepted', 'PI Sent', 'PI Accepted', 'PO Received', 'In Production', 'Dispatched', 'Delivered'];

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function toast(msg) {
  var t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(function () { t.hidden = true; }, 3000);
}
function api(action, body) {
  body = body || {};
  body.action = action;
  body.token = CONFIG.API_TOKEN;   // site key
  body.t = body.t || TOKEN;        // this order's own key
  return fetch(CONFIG.API_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body), redirect: 'follow'
  }).then(function (r) { return r.json(); })
    .then(function (res) { if (!res.ok) throw new Error(res.error || 'Request failed'); return res; });
}

function load() {
  if (!TOKEN) { $('main').innerHTML = '<div class="empty">This link is missing its order reference.</div>'; return; }
  api('orderView', { t: TOKEN })
    .then(function (res) { O = res.order; if (res.site) $('siteName').textContent = res.site.name; render(); })
    .catch(function (e) { $('main').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
}

function timeline() {
  var done = STAGES.indexOf(O.status);
  var terminal = ['Rejected', 'Declined', 'Expired', 'Cancelled'].indexOf(O.status) >= 0;
  if (terminal) {
    return '<div class="note2 warn" style="margin-bottom:16px"><b>' + esc(O.status) + '</b> — this order is closed.</div>';
  }
  return '<div class="stage-row">' + STAGES.map(function (st, i) {
    var cls = i < done ? 'done' : (i === done ? 'now' : '');
    var when = O.status_dates[st] ? new Date(O.status_dates[st]) : null;
    return '<div class="stage ' + cls + '"><span class="dot"></span>' +
      '<span class="lbl">' + esc(st) + '</span>' +
      (when && !isNaN(when) ? '<span class="when">' + when.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + '</span>' : '') +
      '</div>';
  }).join('') + '</div>';
}

function render() {
  var canDecide = O.status === 'PI Sent';
  var canPo = ['PI Accepted', 'PO Received'].indexOf(O.status) >= 0;
  $('main').innerHTML =
    '<div class="page-head"><h1>Order ' + esc(O.id) + '</h1>' +
      '<div class="sub">' + esc(O.company) + ' · raised ' + new Date(O.created).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + '</div></div>' +
    timeline() +

    (canDecide ? '<div class="panel2" style="margin-bottom:16px">' +
      '<h3>Proforma invoice ' + esc(O.pi_number) + '</h3>' +
      '<p class="note-sub">Total ' + inr(O.pi_total) + (O.pi_valid_till ? ' · valid till ' + esc(O.pi_valid_till) : '') + '. Accepting holds the stock for you.</p>' +
      (O.pi_url ? '<a class="btn small" href="' + esc(O.pi_url) + '" target="_blank">Download PI ↗</a> ' : '') +
      '<button class="btn primary small" id="accept">Accept proforma</button> ' +
      '<button class="btn small" id="decline">Decline</button>' +
      '<div class="field" style="margin-top:10px"><label>Note (optional)</label><input id="pNote" placeholder="Anything we should know"></div>' +
    '</div>' : '') +

    (canPo ? '<div class="panel2" style="margin-bottom:16px">' +
      '<h3>Purchase order</h3>' +
      (O.po_url
        ? '<p class="note-sub">Received' + (O.po_number ? ' — ' + esc(O.po_number) : '') + '.</p><a class="btn small" href="' + esc(O.po_url) + '" target="_blank">View PO ↗</a>'
        : '<p class="note-sub">Send us your purchase order to confirm the order. Stock is deducted once it is in.</p>' +
          '<div class="f2"><div class="field"><label>PO number (optional)</label><input id="poNum"></div>' +
          '<div class="field"><label>PO file (PDF)</label><input id="poFile" type="file" accept=".pdf,image/*"></div></div>' +
          '<button class="btn primary small" id="poSend">Send purchase order</button>') +
    '</div>' : '') +

    '<div class="panel2" style="margin-bottom:16px"><h3>Items</h3>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>SKU</th><th>Product</th>' +
      '<th class="num">Qty</th><th class="num">Unit</th><th class="num">GST</th><th class="num">Amount</th></tr></thead><tbody>' +
      O.lines.map(function (l) {
        return '<tr><td>' + esc(l.sku) + '</td><td>' + esc(l.name) + '</td>' +
          '<td class="num">' + l.qty + '</td><td class="num">' +
          (l.list_price && l.list_price > l.unit_price ? '<span class="mrp">' + inr(l.list_price) + '</span> ' : '') +
          inr(l.unit_price) + '</td><td class="num">' + (l.gst || 0) + '%</td>' +
          '<td class="num">' + inr(l.line_total) + '</td></tr>';
      }).join('') +
      '<tr><td colspan="5" class="num" style="font-weight:800">' + (O.pi_total ? 'PI total (incl. GST)' : 'Estimated total') + '</td>' +
      '<td class="num" style="font-weight:800">' + inr(O.pi_total || O.total_est) + '</td></tr>' +
      '</tbody></table></div></div>' +

    (O.shipments.length ? '<div class="panel2"><h3>Shipments</h3>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Date</th><th>Carrier</th>' +
      '<th>Tracking</th><th class="num">Qty</th><th>Status</th></tr></thead><tbody>' +
      O.shipments.map(function (s) {
        return '<tr><td>' + s.no + '</td><td>' + esc(s.date).slice(0, 10) + '</td><td>' + esc(s.carrier) + '</td>' +
          '<td>' + esc(s.tracking) + '</td><td class="num">' + (s.qty || '') + '</td>' +
          '<td><span class="pill st-' + (s.status === 'Delivered' ? 'Delivered' : 'Dispatched') + '">' + esc(s.status) + '</span></td></tr>';
      }).join('') + '</tbody></table></div></div>' : '') +

    (O.pi_url && !canDecide ? '<p class="note" style="margin-top:14px">Documents: ' +
      '<a href="' + esc(O.pi_url) + '" target="_blank">Proforma invoice</a>' +
      (O.po_url ? ' · <a href="' + esc(O.po_url) + '" target="_blank">Purchase order</a>' : '') + '</p>' : '');

  if (canDecide) {
    $('accept').onclick = function () { respond(true); };
    $('decline').onclick = function () { respond(false); };
  }
  if (canPo && !O.po_url) $('poSend').onclick = sendPo;
}

function respond(accept) {
  $('accept').disabled = $('decline').disabled = true;
  api('orderPiRespond', { t: TOKEN, accept: accept, note: $('pNote').value })
    .then(function () { toast(accept ? 'Proforma accepted — stock is held for you' : 'Proforma declined'); load(); })
    .catch(function (e) { toast(e.message); $('accept').disabled = $('decline').disabled = false; });
}

function sendPo() {
  var f = $('poFile').files[0];
  if (!f) { toast('Attach your purchase order first'); return; }
  if (f.size > 10 * 1024 * 1024) { toast('File is over 10MB'); return; }
  $('poSend').disabled = true;
  $('poSend').textContent = 'Sending…';
  var rd = new FileReader();
  rd.onload = function () {
    api('orderPoUpload', { t: TOKEN, filename: f.name, mime: f.type, data: rd.result, po_number: $('poNum').value })
      .then(function () { toast('Purchase order received — your order is confirmed'); load(); })
      .catch(function (e) { toast(e.message); $('poSend').disabled = false; $('poSend').textContent = 'Send purchase order'; });
  };
  rd.readAsDataURL(f);
}

load();
