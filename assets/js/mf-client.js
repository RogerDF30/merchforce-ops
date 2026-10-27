/* Merchforce — the console's connection to Supabase.
 *
 * MF.call('someAction', body) is what api() used to POST to Apps Script. It
 * adds the vendor, then sends the action to the database (rpc mf_some_action)
 * or to the edge function that owns it (files, sync, reports, admin-users),
 * and resolves to the same {ok: true, ...} object, or rejects with the message.
 *
 * The vendor comes from the address: crystalcorner.merchforce.io → crystalcorner.
 * Anywhere else (localhost, previews) ?vendor=<slug> picks one and is remembered.
 */
var MF = (function () {
  'use strict';
  // On *.merchforce.io the sign-in lives in a cookie for the whole domain, so a
  // CompanyStore admin signed in once can open any vendor's console. Elsewhere
  // (previews, localhost) it stays in this site's localStorage.
  var BASE = MF_CONFIG.BASE_DOMAIN;
  var onBase = location.hostname === BASE || location.hostname.slice(-BASE.length - 1) === '.' + BASE;
  function cookieStorage() {
    var CH = 3000, attrs = '; domain=.' + BASE + '; path=/; secure; samesite=lax';
    function read(name) { var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/\./g, '\\.') + '=([^;]*)')); return m ? m[1] : null; }
    return {
      getItem: function (k) {
        var raw = '', n = 0, part;
        while ((part = read(k + '.' + n)) !== null) { raw += part; n++; }
        return raw ? decodeURIComponent(raw) : null;
      },
      setItem: function (k, v) {
        this.removeItem(k);
        var enc = encodeURIComponent(v);
        for (var i = 0, n = 0; i < enc.length; i += CH, n++) document.cookie = k + '.' + n + '=' + enc.slice(i, i + CH) + attrs + '; max-age=2592000';
      },
      removeItem: function (k) { for (var n = 0; n < 12; n++) document.cookie = k + '.' + n + '=' + attrs + '; max-age=0'; }
    };
  }
  var sb = window.supabase.createClient(MF_CONFIG.SUPABASE_URL, MF_CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'mf_auth', storage: onBase ? cookieStorage() : undefined }
  });

  var RESERVED = { www: 1, app: 1, admin: 1, platform: 1, api: 1 };
  function vendorSlug() {
    var host = location.hostname.toLowerCase(), base = MF_CONFIG.BASE_DOMAIN;
    if (host.slice(-base.length - 1) === '.' + base) {
      var sub = host.slice(0, -base.length - 1).split('.').pop();
      if (sub && !RESERVED[sub]) return sub;
    }
    var q = new URLSearchParams(location.search).get('vendor');
    try {
      if (q) localStorage.setItem('mf_vendor', q.toLowerCase());
      return (q || localStorage.getItem('mf_vendor') || '').toLowerCase();
    } catch (e) { return (q || '').toLowerCase(); }
  }
  var VENDOR = vendorSlug();

  // Actions that need storage, email, Google or the Auth admin API live in edge functions.
  var EDGE = {
    adminUsers: 'admin-users', adminUserSave: 'admin-users', platformVendorCreate: 'admin-users', platformAdminSave: 'admin-users',
    adminAnalytics: 'reports',
    adminSyncPreview: 'sync', adminSyncRun: 'sync', adminSyncTemplate: 'sync', adminSyncWriteBackAll: 'sync'
  };
  ['adminOrders', 'orderView', 'adminReturns', 'adminAccountNotes', 'adminPiBuild', 'adminPiUpload', 'adminPoUpload',
   'orderPoUpload', 'adminReturnClose', 'adminAccountFileUpload', 'adminAccountFileDelete', 'adminImageUpload',
   'adminDecks', 'adminDeckBuild', 'adminDeckSend', 'adminDeckDelete'].forEach(function (a) { EDGE[a] = 'files'; });

  function snake(a) { return a.replace(/[A-Z]/g, function (m) { return '_' + m.toLowerCase(); }); }

  function fail(msg) { return Promise.reject(new Error(msg || 'Request failed')); }

  function call(action, body) {
    body = Object.assign({}, body || {}, { vendor: VENDOR });
    var p = EDGE[action]
      ? sb.functions.invoke(EDGE[action], { body: Object.assign({ action: action }, body) }).then(function (r) {
          if (r.error) {
            // the function answered {ok:false, error} with a non-2xx status, or could not be reached
            var ctx = r.error.context;
            if (ctx && typeof ctx.json === 'function') return ctx.json().then(function (j) { return j; }, function () { return { ok: false, error: r.error.message }; });
            return { ok: false, error: r.error.message };
          }
          return r.data;
        })
      : sb.rpc('mf_' + snake(action), { p: body }).then(function (r) {
          return r.error ? { ok: false, error: r.error.message } : r.data;
        });
    return p.then(function (res) {
      if (!res || res.ok === false) return fail(res && res.error);
      return res;
    }, function (e) {
      return fail(action + ': could not reach the backend (' + (e.message || e) + ')');
    });
  }

  /** Where a vendor's console lives: its own subdomain on merchforce.io, else ?vendor= on this site. */
  function consoleUrl(slug, tab) {
    var base = onBase ? 'https://' + slug + '.' + BASE + '/admin.html' : location.origin + '/admin.html?vendor=' + encodeURIComponent(slug);
    return base + (tab ? '#' + tab : '');
  }

  return {
    vendor: VENDOR,
    consoleUrl: consoleUrl,
    call: call,
    signIn: function (email, password) {
      return sb.auth.signInWithPassword({ email: email, password: password }).then(function (r) {
        if (r.error) return fail(/invalid/i.test(r.error.message) ? 'Invalid email or password' : r.error.message);
        return r.data;
      });
    },
    signOut: function () { return sb.auth.signOut().catch(function () {}); },
    hasSession: function () { return sb.auth.getSession().then(function (r) { return !!(r.data && r.data.session); }); }
  };
})();
