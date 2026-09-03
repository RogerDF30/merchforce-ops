/**
 * Merchforce Ops — staff sign-in.
 *
 * The console used to be gated by one shared admin key, so the audit log could
 * only ever say "admin". Staff now sign in with their own email and password;
 * the session is an HMAC-signed token carrying who they are and when it lapses,
 * so no session table is needed.
 *
 * Expiry is INACTIVITY, not a fixed lifetime: every authenticated call returns
 * a re-signed token with the window pushed out again. Stop using the console
 * for session_minutes and the next call is refused. The master key in Script
 * Properties still works, as the recovery path and for creating the first
 * account; the audit log records it as "master".
 */

function sessionMinutes_() {
  var n = toNum_(getSettings_().session_minutes);
  return n >= 5 && n <= 480 ? n : 30;
}

function fnStaffLogin_(p) {
  var email = String(p.email || '').toLowerCase().trim();
  var pass = String(p.password || '');
  if (!email || !pass) return err_('Email and password are required');

  var rowNum = findRow_('Users', function (r) { return String(r.email).toLowerCase() === email; });
  if (rowNum < 0) { audit_(email, 'login_fail', '', 'no such user'); return err_('Invalid email or password'); }
  var u = readRows_('Users')[rowNum - 2];
  if (!isTrue_(u.active)) { audit_(email, 'login_fail', '', 'disabled'); return err_('This account is disabled'); }
  if (hashPassword_(pass, u.salt) !== u.pass_hash) {
    audit_(email, 'login_fail', '', 'bad password');
    return err_('Invalid email or password');
  }
  u.last_login = now_();
  writeRecord_('Users', rowNum, u);
  audit_(email, 'login_ok', '', '');

  var user = { email: u.email, name: u.name || u.email, role: u.role || 'staff' };
  return ok_({
    session: makeStaffSession_(user),
    user: user,
    session_minutes: sessionMinutes_(),
    settings: getSettings_(),
    relay_status: relayStatus_()
  });
}

function makeStaffSession_(user) {
  var exp = now_().getTime() + sessionMinutes_() * 60 * 1000;
  var payload = JSON.stringify({ e: user.email, n: user.name, r: user.role, x: exp });
  return Utilities.base64EncodeWebSafe(payload) + '.' + sign_(payload);
}

/** Returns {email, name, role} for a live token, or null. */
function staffSession_(token) {
  if (!token) return null;
  var parts = String(token).split('.');
  if (parts.length !== 2) return null;
  try {
    var payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
    if (sign_(payload) !== parts[1]) return null;
    var d = JSON.parse(payload);
    if (!d.x || now_().getTime() >= Number(d.x)) return null;
    return { email: d.e, name: d.n, role: d.r || 'staff' };
  } catch (e) { return null; }
}

function sign_(payload) {
  var key = props_().getProperty('PEPPER') || 'k';
  var raw = Utilities.computeHmacSha256Signature(payload, key);
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
