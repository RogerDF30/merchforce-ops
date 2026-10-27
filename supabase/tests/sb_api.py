"""Client for the Merchforce Supabase backend, for tests and scripts.

Mirrors the console's transport: api('fooBar', body) -> POST /rest/v1/rpc/mf_foo_bar {p: body}
with the signed-in user's JWT. Errors come back as {ok: False, error: message},
the shape the Apps Script backend used, so the workflow suite reads the same.

Secrets come from supabase/.secrets.local and the API keys are fetched with the
access token at import time. Nothing here prints a secret.
"""
import json, os, re, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SB = os.path.dirname(HERE)


def _secrets():
    out = {}
    for line in open(os.path.join(SB, '.secrets.local'), encoding='utf-8'):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            out[k.strip()] = v.strip()
    return out


_S = _secrets()
REF = _S['SUPABASE_PROJECT_REF']
URL = 'https://%s.supabase.co' % REF


def _http(method, url, body=None, headers=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=dict({'Content-Type': 'application/json'}, **(headers or {})))
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {'message': raw[:300]}
        except urllib.error.URLError:
            if attempt == 2:
                raise
            time.sleep(2)


def _keys():
    st, rows = _http('GET', 'https://api.supabase.com/v1/projects/%s/api-keys' % REF,
                     headers={'Authorization': 'Bearer ' + _S['SUPABASE_ACCESS_TOKEN']})
    if st != 200:
        raise RuntimeError('could not fetch API keys (HTTP %s)' % st)
    by = {r['name']: r['api_key'] for r in rows if r.get('api_key')}
    return by['anon'], by['service_role']


ANON, SERVICE = _keys()


def snake(action):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', action).lower()


# Actions served by edge functions rather than SQL (they need the Auth admin
# API, storage, email or Google). The console routes the same way.
EDGE = {'adminUsers': 'admin-users', 'adminUserSave': 'admin-users', 'platformVendorCreate': 'admin-users', 'platformAdminSave': 'admin-users'}
EDGE.update({a: 'files' for a in ('adminOrders', 'orderView', 'adminReturns', 'adminAccountNotes', 'adminPiBuild',
                                  'adminPiUpload', 'adminPoUpload', 'orderPoUpload', 'adminReturnClose',
                                  'adminAccountFileUpload', 'adminAccountFileDelete', 'adminImageUpload')})
EDGE['adminAnalytics'] = 'reports'
EDGE.update({a: 'files' for a in ('adminDecks', 'adminDeckBuild', 'adminDeckSend', 'adminDeckDelete')})
EDGE.update({a: 'sync' for a in ('adminSyncPreview', 'adminSyncRun', 'adminSyncTemplate', 'adminSyncWriteBackAll')})


def rpc(action, body=None, jwt=None):
    """Call an action. jwt=None calls as a signed-out visitor (customer order page)."""
    hdr = {'apikey': ANON, 'Authorization': 'Bearer ' + (jwt or ANON)}
    if action in EDGE:
        st, out = _http('POST', '%s/functions/v1/%s' % (URL, EDGE[action]), dict(body or {}, action=action), hdr)
        if st >= 400 and not (isinstance(out, dict) and 'ok' in out):
            return {'ok': False, 'error': (out or {}).get('message') or (out or {}).get('msg') or 'HTTP %s' % st}
        return out
    st, out = _http('POST', '%s/rest/v1/rpc/mf_%s' % (URL, snake(action)), {'p': body or {}}, hdr)
    if st >= 400:
        return {'ok': False, 'error': (out or {}).get('message', 'HTTP %s' % st)}
    return out


def sign_in(email, password):
    st, out = _http('POST', URL + '/auth/v1/token?grant_type=password', {'email': email, 'password': password},
                    {'apikey': ANON})
    if st != 200:
        return None
    return out['access_token']


def admin_user(email, password):
    """Create (or find) a confirmed sign-in with the service key. Returns the user id."""
    hdr = {'apikey': SERVICE, 'Authorization': 'Bearer ' + SERVICE}
    st, out = _http('POST', URL + '/auth/v1/admin/users', {'email': email, 'password': password, 'email_confirm': True}, hdr)
    if st in (200, 201):
        return out['id']
    page = 1
    while True:
        st, out = _http('GET', URL + '/auth/v1/admin/users?page=%d&per_page=200' % page, headers=hdr)
        users = (out or {}).get('users', [])
        for u in users:
            if u.get('email', '').lower() == email.lower():
                _http('PUT', URL + '/auth/v1/admin/users/' + u['id'], {'password': password}, hdr)
                return u['id']
        if len(users) < 200:
            raise RuntimeError('could not create or find user %s' % email)
        page += 1


def sql(query):
    """Run SQL as the database owner over the session pooler (test setup only). Returns stdout."""
    import subprocess
    env = dict(os.environ, PGPASSWORD=_S['SUPABASE_DB_PASSWORD'], PGSSLMODE='require')
    r = subprocess.run(['/opt/homebrew/opt/postgresql@16/bin/psql', '-h', 'aws-0-ap-south-1.pooler.supabase.com', '-p', '5432',
                        '-U', 'postgres.' + REF, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', query],
                       env=env, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError('SQL failed: ' + r.stderr.strip()[:300])
    return r.stdout.strip()
