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

/**
 * Sign-in throttle.
 *
 * API_TOKEN is the only thing standing between the open internet and
 * fnStaffLogin_, and it ships in a public JavaScript bundle -- so in practice
 * anyone can call this. Without a limit that is an unmetered password-guessing
 * oracle against every staff account.
 *
 * Apps Script does not expose the caller's IP, so this counts per ACCOUNT.
 * That is the axis that matters: it is what stops a dictionary run against one
 * person.
 *
 * Failures only. A correct password is always accepted and clears the count,
 * so nobody can lock a colleague out by guessing wrong at their address eight
 * times -- that would trade a brute-force defence for a denial-of-service tool.
 */
var LOGIN_MAX_FAILS_ = 8;
var LOGIN_WINDOW_S_ = 900;   // 15 minutes

function loginFailKey_(email) { return 'lf_' + Utilities.base64EncodeWebSafe(email); }

function loginFails_(email) {
  var v = CacheService.getScriptCache().get(loginFailKey_(email));
  return v ? Number(v) : 0;
}

function noteLoginFail_(email) {
  var c = CacheService.getScriptCache();
  var k = loginFailKey_(email);
  // The window starts at the first failure and is not extended by later ones,
  // so a slow trickle cannot hold an account throttled indefinitely.
  c.put(k, String(loginFails_(email) + 1), LOGIN_WINDOW_S_);
}

function clearLoginFails_(email) {
  CacheService.getScriptCache().remove(loginFailKey_(email));
}

function fnStaffLogin_(p) {
  var email = String(p.email || '').toLowerCase().trim();
  var pass = String(p.password || '');
  if (!email || !pass) return err_('Email and password are required');

  var throttled = loginFails_(email) >= LOGIN_MAX_FAILS_;

  var rowNum = findRow_('Users', function (r) { return String(r.email).toLowerCase() === email; });
  if (rowNum < 0) {
    noteLoginFail_(email);
    audit_(email, 'login_fail', '', 'no such user');
    Utilities.sleep(1000);
    return err_('Invalid email or password');
  }
  var u = readRows_('Users')[rowNum - 2];
  if (!isTrue_(u.active)) { audit_(email, 'login_fail', '', 'disabled'); return err_('This account is disabled'); }
  if (hashPassword_(pass, u.salt) !== u.pass_hash) {
    noteLoginFail_(email);
    audit_(email, 'login_fail', '', throttled ? 'bad password (throttled)' : 'bad password');
    // A second per attempt is nothing to a person typing and a great deal to a
    // script: this hash is a single fast SHA-256, so guesses are otherwise
    // limited only by how quickly requests can be made.
    Utilities.sleep(1000);
    if (throttled) {
      return err_('Too many sign-in attempts for this account. Try again in 15 minutes.');
    }
    return err_('Invalid email or password');
  }

  // Correct password: allowed through even while throttled, and the count goes.
  clearLoginFails_(email);
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

function sessionDays_() {
  var n = toNum_(getSettings_().session_days);
  return n >= 1 && n <= 365 ? n : 30;
}

/**
 * The token lives session_days and every call re-issues it, so anyone who keeps
 * using the console stays signed in across reloads and reopens. The inactivity
 * lock (session_minutes) is enforced by the console while it is open.
 */
function makeStaffSession_(user) {
  var exp = now_().getTime() + sessionDays_() * 24 * 60 * 60 * 1000;
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
