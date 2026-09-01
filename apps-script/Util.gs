/** Merchforce — shared helpers */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok_(data)  { data = data || {}; data.ok = true;  return json_(data); }
function err_(msg)  { return json_({ ok: false, error: String(msg) }); }

function sheet_(name) {
  var sh = db_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}

/** Read a tab into an array of objects keyed by the SHEETS schema. */
function readRows_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var cols = SHEETS[name];
  var vals = sh.getRange(2, 1, last - 1, cols.length).getValues();
  return vals.map(function (row) {
    var o = {};
    cols.forEach(function (c, i) { o[c] = row[i]; });
    return o;
  });
}

/** Find 1-based sheet row for the first record matching pred. Returns -1 if none. */
function findRow_(name, pred) {
  var rows = readRows_(name);
  for (var i = 0; i < rows.length; i++) if (pred(rows[i])) return i + 2;
  return -1;
}

function writeRecord_(name, rowNum, record) {
  var cols = SHEETS[name];
  var vals = cols.map(function (c) { return (c in record) ? record[c] : ''; });
  sheet_(name).getRange(rowNum, 1, 1, cols.length).setValues([vals]);
}

function appendRecord_(name, record) {
  var cols = SHEETS[name];
  sheet_(name).appendRow(cols.map(function (c) { return (c in record) ? record[c] : ''; }));
}

function now_() { return new Date(); }
function today_() { return Utilities.formatDate(now_(), 'Asia/Kolkata', 'yyyy-MM-dd'); }

function randomToken_(n) {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  var out = '';
  for (var i = 0; i < n; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function hashPassword_(pw, salt) {
  var pepper = props_().getProperty('PEPPER') || '';
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + pw + pepper);
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function audit_(actor, action, ref, detail) {
  try {
    appendRecord_('AuditLog', {
      ts: now_(), actor: actor || 'anon', action: action, ref: ref || '', detail: detail || ''
    });
  } catch (e) { /* audit is best-effort */ }
}

function toNum_(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

/** Available to Promise: what buyers are allowed to be promised. */
function atp_(p) {
  return Math.max(0, toNum_(p.on_hand) - toNum_(p.reserved) - toNum_(p.safety_stock));
}

function nextRequestId_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var seq = toNum_(props_().getProperty('REQ_SEQ')) + 1;
    props_().setProperty('REQ_SEQ', String(seq));
    var year = Utilities.formatDate(now_(), 'Asia/Kolkata', 'yyyy');
    return 'MF-' + year + '-' + ('0000' + seq).slice(-4);
  } finally {
    lock.releaseLock();
  }
}

/** Sheets coerces the string 'TRUE' to boolean true on write — accept both. */
function isTrue_(v) { return String(v).toUpperCase() === 'TRUE'; }

/** Sheets stores numeric-looking SKUs as numbers — always compare via this key. */
function skuKey_(v) { return String(v === undefined || v === null ? '' : v).trim().toUpperCase(); }
