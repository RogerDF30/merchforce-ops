/* Merchforce Platform — CompanyStore's own screen: suppliers, the catalogue across
   them, and CompanyStore admins (editors change things, viewers only look). */
'use strict';

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(function () { t.hidden = true; }, 3500); }
function fmtDate(d) { var x = d ? new Date(d) : null; return x && !isNaN(x) ? x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
function inr(n) { return n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
function openDrawer(html) { $('mBody').innerHTML = html; $('mOverlay').hidden = false; }
function closeDrawer() { $('mOverlay').hidden = true; }
$('mClose').onclick = closeDrawer;
function stat(v, l) { return '<div class="stat"><div class="stat-n">' + v + '</div><div class="stat-l">' + l + '</div></div>'; }
function show(signedIn) { $('lock').hidden = signedIn; $('console').hidden = !signedIn; }

var P = { me: null, vendors: [] };
function isEditor() { return P.me && P.me.role === 'editor'; }

/* ---------------- suppliers ---------------- */
function loadVendors() {
  return MF.call('platformVendors').then(function (res) {
    var vs = P.vendors = res.vendors;
    $('stats').innerHTML = stat(vs.length, 'Suppliers') +
      stat(vs.reduce(function (s, v) { return s + v.products; }, 0), 'Products across suppliers') +
      stat(vs.reduce(function (s, v) { return s + v.orders; }, 0), 'Orders across suppliers') +
      stat(vs.filter(function (v) { return v.last_order && Date.now() - new Date(v.last_order) < 30 * 864e5; }).length, 'Active in the last 30 days');
    $('rows').innerHTML = vs.length ? vs.map(function (v) {
      return '<tr><td><b>' + esc(v.name) + '</b>' + (v.active ? '' : ' <span class="pill st-Cancelled">inactive</span>') + '<br><small style="color:var(--ink-3)">' + esc(v.slug) + '</small></td>' +
        '<td style="font-size:12.5px">' + esc(v.url.replace('https://', '')) + '</td>' +
        '<td style="font-size:12.5px">' + esc((v.admins || []).join(', ') || '—') + '</td>' +
        '<td class="num">' + v.members + '</td><td class="num">' + v.products + '</td><td class="num">' + v.orders + '</td>' +
        '<td>' + fmtDate(v.last_order) + '</td>' +
        '<td>' + (v.mail_mode === 'off' ? '<span class="pill st-Cancelled">off</span>' : esc(v.mail_mode || 'backend')) + '</td>' +
        '<td><a class="btn small" href="' + esc(MF.consoleUrl(v.slug)) + '" target="_blank">Open console ↗</a></td></tr>';
    }).join('') : '<tr><td colspan="9"><div class="empty" style="padding:26px 0">No suppliers yet.</div></td></tr>';
    $('cVendor').innerHTML = '<option value="">All suppliers</option>' + vs.map(function (v) { return '<option value="' + esc(v.slug) + '">' + esc(v.name) + '</option>'; }).join('');
  });
}

function newVendor() {
  openDrawer(
    '<h2 style="margin:0 0 4px">New supplier</h2>' +
    '<p class="note" style="margin:0 0 14px">Creates the supplier\'s own space, its address, and its first admin sign-in. Everything else (company details, staff, stock sheet) they set up in their console.</p>' +
    '<div class="f2">' +
      '<div class="field"><label>Business name</label><input id="vName" placeholder="Crystal Corner"></div>' +
      '<div class="field"><label>Subdomain</label><input id="vSlug" placeholder="crystalcorner"></div>' +
    '</div>' +
    '<p class="note" id="vUrl" style="margin:-6px 0 12px"></p>' +
    '<div class="f2">' +
      '<div class="field"><label>Admin name</label><input id="vAdminName"></div>' +
      '<div class="field"><label>Admin email</label><input id="vAdminEmail" type="email"></div>' +
    '</div>' +
    '<div class="field"><label>Starting password (10+ characters; not needed if they already have a Merchforce sign-in)</label><input id="vPass" type="text" autocomplete="off"></div>' +
    '<div class="form-err" id="mErr"></div>' +
    '<button class="btn primary" id="vGo" style="width:100%;justify-content:center">Create supplier</button>');
  var slugOf = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40); };
  var paintUrl = function () { var s = $('vSlug').value.trim(); $('vUrl').textContent = s ? 'Their console: https://' + s + '.merchforce.io/admin.html' : ''; };
  $('vName').oninput = function () { if (!$('vSlug').dataset.touched) $('vSlug').value = slugOf($('vName').value); paintUrl(); };
  $('vSlug').oninput = function () { $('vSlug').dataset.touched = '1'; paintUrl(); };
  $('vPass').value = 'Mf-' + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
  $('vGo').onclick = function () {
    var pass = $('vPass').value;
    $('vGo').disabled = true; $('mErr').textContent = '';
    MF.call('platformVendorCreate', { name: $('vName').value.trim(), slug: $('vSlug').value.trim(),
      admin_name: $('vAdminName').value.trim(), admin_email: $('vAdminEmail').value.trim(), admin_password: pass })
      .then(function (res) {
        openDrawer('<h2 style="margin:0 0 10px">' + esc(res.vendor.name) + ' is ready</h2>' +
          '<div class="card-block"><b>Console:</b> <a href="' + esc(MF.consoleUrl(res.vendor.slug)) + '" target="_blank">' + esc(res.vendor.url) + '/admin.html</a><br>' +
          '<b>Admin:</b> ' + esc(res.admin.email) + '<br>' +
          (res.admin.created ? '<b>Starting password:</b> <code>' + esc(pass) + '</code><br><small style="color:var(--ink-3)">Share it privately; they can change it later.</small>'
                             : '<small style="color:var(--ink-3)">They already had a Merchforce sign-in, so their existing password works.</small>') +
          '</div><p class="note">Next for them: Settings → Company (name, GSTIN, address), then Sheet sync. Their emails are on.</p>');
        loadVendors();
      }).catch(function (e) { $('mErr').textContent = e.message; $('vGo').disabled = false; });
  };
}

/* ---------------- catalogue across suppliers ---------------- */
var catTimer = null, catSeq = 0;
function loadCatalog() {
  var seq = ++catSeq;               // only the latest search may paint: a slow earlier answer must not overwrite it
  $('cCount').textContent = 'Loading…';
  return MF.call('platformCatalog', { q: $('cQ').value.trim(), vendor_slug: $('cVendor').value, limit: 500 }).then(function (res) {
    if (seq !== catSeq) return;
    var ps = res.products;
    $('cCount').textContent = ps.length + ' of ' + res.total + ' products' + (ps.length === 500 ? ' (first 500; narrow the search)' : '');
    $('cRows').innerHTML = ps.length ? ps.map(function (p) {
      return '<tr><td>' + (p.image ? '<img class="prod-img" style="width:38px;height:38px" src="' + esc(p.image) + '">' : '') + '</td>' +
        '<td><b>' + esc(p.vendor) + '</b></td><td>' + esc(p.sku) + '</td>' +
        '<td>' + esc(p.name) + (p.review_pending ? ' <span class="pill st-New">new from sheet</span>' : '') + '<br><small style="color:var(--ink-3)">' + esc(p.category) + '</small></td>' +
        '<td>' + esc(p.brand || '—') + '</td><td class="num">' + p.moq + '</td><td class="num">' + inr(p.price) + '</td>' +
        '<td class="num">' + Number(p.on_hand).toLocaleString('en-IN') + '</td>' +
        '<td class="num" style="font-weight:800">' + Number(p.atp).toLocaleString('en-IN') + '</td>' +
        '<td>' + (p.visible ? '✓' : '—') + '</td>' +
        '<td><a class="btn ghost small" href="' + esc(MF.consoleUrl(p.vendor_slug, 'catalog')) + '" target="_blank">Open ↗</a></td></tr>';
    }).join('') : '<tr><td colspan="11"><div class="empty" style="padding:26px 0">No product matches.</div></td></tr>';
  }).catch(function (e) { $('cCount').textContent = e.message; });
}
$('cQ').oninput = function () { clearTimeout(catTimer); catTimer = setTimeout(loadCatalog, 300); };
$('cVendor').onchange = loadCatalog;

/* ---------------- CompanyStore admins ---------------- */
function loadAdmins() {
  return MF.call('platformAdmins').then(function (res) {
    $('aRows').innerHTML = res.admins.map(function (a) {
      return '<tr><td><b>' + esc(a.name || '—') + '</b>' + (a.you ? ' <span class="pill" style="background:var(--accent-soft);color:var(--accent)">you</span>' : '') + '</td>' +
        '<td>' + esc(a.email) + '</td>' +
        '<td><span class="pill ' + (a.role === 'editor' ? 'st-PIAccepted' : 'st-Closed') + '">' + (a.role === 'editor' ? 'Editor' : 'Viewer') + '</span></td>' +
        '<td style="font-size:12.5px">' + esc(a.created_by || '—') + '</td>' +
        '<td>' + (isEditor() && !a.you ? '<button class="btn ghost small" data-edit="' + esc(a.email) + '">Change</button> <button class="btn ghost small" data-del="' + esc(a.email) + '" style="color:var(--bad)">Remove</button>' : '') + '</td></tr>';
    }).join('');
    $('aRows').querySelectorAll('button[data-edit]').forEach(function (b) {
      b.onclick = function () { editAdmin(res.admins.filter(function (a) { return a.email === b.dataset.edit; })[0]); };
    });
    $('aRows').querySelectorAll('button[data-del]').forEach(function (b) {
      b.onclick = function () {
        b.disabled = true;
        MF.call('platformAdminRemove', { email: b.dataset.del }).then(function () { toast(b.dataset.del + ' removed'); loadAdmins(); })
          .catch(function (e) { toast(e.message); b.disabled = false; });
      };
    });
  });
}

function editAdmin(a) {
  var isNew = !a;
  a = a || { email: '', name: '', role: 'viewer' };
  openDrawer('<h2 style="margin:0 0 4px">' + (isNew ? 'Add a CompanyStore admin' : esc(a.name || a.email)) + '</h2>' +
    '<p class="note" style="margin:0 0 14px">Editors can change any supplier\'s data and manage admins. Viewers can look at everything and change nothing.</p>' +
    '<div class="f2"><div class="field"><label>Name</label><input id="aName" value="' + esc(a.name) + '"></div>' +
      '<div class="field"><label>Email</label><input id="aEmail" type="email" value="' + esc(a.email) + '"' + (isNew ? '' : ' readonly') + '></div></div>' +
    '<div class="field"><label>Role</label><select id="aRole">' +
      '<option value="viewer"' + (a.role === 'viewer' ? ' selected' : '') + '>Viewer — sees everything, changes nothing</option>' +
      '<option value="editor"' + (a.role === 'editor' ? ' selected' : '') + '>Editor — can change any supplier\'s data</option></select></div>' +
    (isNew ? '<div class="field"><label>Starting password (10+ characters; not needed if they already have a Merchforce sign-in)</label><input id="aPass" type="text" autocomplete="off"></div>' : '') +
    '<div class="form-err" id="mErr"></div>' +
    '<button class="btn primary" id="aGo" style="width:100%;justify-content:center">' + (isNew ? 'Add admin' : 'Save') + '</button>');
  if (isNew) $('aPass').value = 'Mf-' + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
  $('aGo').onclick = function () {
    var pass = isNew ? $('aPass').value : '';
    $('aGo').disabled = true; $('mErr').textContent = '';
    MF.call('platformAdminSave', { email: $('aEmail').value.trim(), name: $('aName').value.trim(), role: $('aRole').value, password: pass })
      .then(function (res) {
        if (isNew && res.created) {
          openDrawer('<h2 style="margin:0 0 10px">' + esc(res.email) + ' added</h2><div class="card-block"><b>Role:</b> ' + esc(res.role) +
            '<br><b>Starting password:</b> <code>' + esc(pass) + '</code><br><small style="color:var(--ink-3)">Share it privately. They sign in at this same platform page.</small></div>');
        } else { closeDrawer(); toast(res.email + ' is now ' + (res.role === 'editor' ? 'an editor' : 'a viewer')); }
        loadAdmins();
      }).catch(function (e) { $('mErr').textContent = e.message; $('aGo').disabled = false; });
  };
}

/* ---------------- shell ---------------- */
var LOADERS = { vendors: loadVendors, catalog: loadCatalog, admins: loadAdmins };
document.querySelectorAll('#tabs .chip').forEach(function (c) {
  c.onclick = function () {
    document.querySelectorAll('#tabs .chip').forEach(function (x) { x.classList.toggle('on', x === c); });
    document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.id !== 'p-' + c.dataset.t; });
    LOADERS[c.dataset.t]();
  };
});

function enter() {
  return MF.call('platformMe').then(function (res) {
    P.me = res.me;
    $('whoami').textContent = (P.me.name || P.me.email) + ' · ' + (isEditor() ? 'editor' : 'view-only');
    $('newVendor').hidden = $('newAdmin').hidden = !isEditor();
    return loadVendors();
  }).then(function () { show(true); });
}

$('newVendor').onclick = newVendor;
$('newAdmin').onclick = function () { editAdmin(null); };
$('logout').onclick = function () { MF.signOut().then(function () { show(false); }); };
$('loginBtn').onclick = function () {
  $('loginBtn').disabled = true; $('lockErr').textContent = '';
  MF.signIn($('lEmail').value.trim(), $('lPass').value).then(enter).then(function () {
    $('loginBtn').disabled = false;
  }).catch(function (e) {
    $('loginBtn').disabled = false;
    $('lockErr').textContent = /platform admin/i.test(e.message) ? 'This sign-in is not a CompanyStore platform admin.' : e.message;
    if (/platform admin/i.test(e.message)) MF.signOut();
  });
};
$('lPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('loginBtn').click(); });
MF.hasSession().then(function (yes) { if (yes) enter().catch(function () { show(false); }); });
