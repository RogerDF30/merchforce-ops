"""CompanyStore platform admins: editors change things, viewers only look.
The test platform account (editor) creates a viewer, then the viewer tries
every kind of change and must be refused, while reads keep working.
    python3 -I supabase/tests/platform_roles_test.py
"""
import base64, json, os, secrets, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import api_sb, sb_api as sb

R = []
def check(name, ok, obs=''):
    R.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + 'Platform roles :: ' + name + ('' if ok else '  -> ' + str(obs)[:220]))

U = api_sb.USERS
editor = sb.sign_in(U['platform']['email'], U['platform']['password'])
V = 'mftest'
PDF = 'data:application/pdf;base64,' + base64.b64encode(b'%PDF-1.4\n%%EOF').decode()

# the viewer's sign-in (kept in the git-ignored test users file)
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.test-users.local')
if 'pviewer' not in U:
    U['pviewer'] = {'email': 'roger+mfpviewer@companystore.io', 'password': 'mfT-' + secrets.token_urlsafe(14)}
    open(path, 'w').write(json.dumps(U, indent=1))

r = sb.rpc('platformAdminSave', {'email': U['pviewer']['email'], 'name': 'Test Viewer', 'role': 'viewer', 'password': U['pviewer']['password']}, editor)
check('Editor adds a view-only platform admin', r.get('ok') and r.get('role') == 'viewer', r)
admins = sb.rpc('platformAdmins', {}, editor).get('admins', [])
check('Platform admins list shows roles', any(a['email'] == U['pviewer']['email'] and a['role'] == 'viewer' for a in admins), admins)
viewer = sb.sign_in(U['pviewer']['email'], U['pviewer']['password'])

# ---- viewer can see
me = sb.rpc('me', {'vendor': V}, viewer)
check('Viewer opens any vendor console, marked view-only', me.get('ok') and me['user']['role'] == 'viewer' and me['user']['acting_for'], me.get('user'))
check('Viewer sees the vendor catalogue', len(sb.rpc('adminCatalog', {'vendor': V}, viewer).get('products', [])) > 0)
check('Viewer sees orders (with document links)', sb.rpc('adminOrders', {'vendor': V}, viewer).get('ok'))
check('Viewer sees the cross-vendor catalogue', sb.rpc('platformCatalog', {}, viewer).get('ok'))
check('Viewer sees vendors list', sb.rpc('platformVendors', {}, viewer).get('ok'))
check('Viewer sees analytics', sb.rpc('adminAnalytics', {'vendor': V, 'days': 90}, viewer).get('ok'))

# ---- viewer cannot change anything
def refused(r):
    return not r.get('ok') and 'view-only' in r.get('error', '')
p = next(x for x in sb.rpc('adminCatalog', {'vendor': V}, viewer)['products'] if x['sku'] == 'URBAN-294')
before = p['on_hand']
r = sb.rpc('adminProductSave', {'vendor': V, 'product': dict(p, on_hand=1, tiers=p['tiers'])}, viewer)
after = next(x for x in sb.rpc('adminCatalog', {'vendor': V}, editor)['products'] if x['sku'] == 'URBAN-294')['on_hand']
check('Viewer cannot edit a product (stock unchanged)', refused(r) and after == before, (r, before, after))
check('Viewer cannot raise an enquiry', refused(sb.rpc('adminRequestCreate', {'vendor': V, 'company': 'X', 'contact': 'Y', 'email': 'a@b.co',
                                                                            'lines': [{'sku': 'URBAN-294', 'qty': 25}]}, viewer)))
check('Viewer cannot add a company', refused(sb.rpc('adminCompanySave', {'vendor': V, 'company': {'name': 'Nope'}}, viewer)))
check('Viewer cannot upload a file (refused before storing)', refused(sb.rpc('adminImageUpload', {'vendor': V, 'filename': 'x.png', 'data': PDF}, viewer)))
check('Viewer cannot build a deck', refused(sb.rpc('adminDeckBuild', {'vendor': V, 'name': 'x', 'skus': ['URBAN-294']}, viewer)))
check('Viewer cannot open or change settings', refused(sb.rpc('adminSettings', {'vendor': V, 'save': {'site_name': 'hacked'}}, viewer)))
check('Viewer cannot manage vendor staff', refused(sb.rpc('adminUserSave', {'vendor': V, 'user': {'email': 'z@z.co', 'password': 'whatever-123'}}, viewer)))
check('Viewer cannot create a vendor', refused(sb.rpc('platformVendorCreate', {'slug': 'viewernope', 'name': 'x', 'admin_email': 'v@v.co', 'admin_password': 'abcdefghijk'}, viewer)))
r = sb.rpc('platformAdminSave', {'email': U['pviewer']['email'], 'role': 'editor'}, viewer)
check('Viewer cannot promote themselves', not r.get('ok') and 'editor' in r.get('error', ''), r)

# ---- editor acts for a vendor; their name is on the change
oid = sb.rpc('adminRequestCreate', {'vendor': V, 'company': 'TEST platform edit', 'contact': 'T', 'email': 'roger+mftest@companystore.io',
                                     'lines': [{'sku': 'URBAN-294', 'qty': 25}]}, editor).get('request_id')
o = next((x for x in sb.rpc('adminOrders', {'vendor': V}, api_sb.jwt('owner'))['orders'] if x['id'] == oid), {})
check('Editor makes changes inside a vendor', bool(oid), oid)
check('Change is recorded under the editor, not the vendor', o.get('raised_by') == U['platform']['email'], o.get('raised_by'))

# ---- admin management rules
r = sb.rpc('platformAdminSave', {'email': U['platform']['email'], 'role': 'viewer'}, editor)
check('Editor cannot demote themselves', not r.get('ok') and 'own editor' in r.get('error', ''), r)
r = sb.rpc('platformAdminSave', {'email': U['pviewer']['email'], 'role': 'editor'}, editor)
check('Editor promotes a viewer to editor', r.get('ok') and r.get('role') == 'editor', r)
sb.rpc('platformAdminSave', {'email': U['pviewer']['email'], 'role': 'viewer'}, editor)
r = sb.rpc('platformAdminRemove', {'email': U['pviewer']['email']}, editor)
check('Editor removes a platform admin', r.get('ok'), r)
check('Removed admin loses access', not sb.rpc('platformVendors', {}, viewer).get('ok'))
sb.rpc('platformAdminSave', {'email': U['pviewer']['email'], 'name': 'Test Viewer', 'role': 'viewer'}, editor)   # keep for UI tests
print('%d/%d passed' % (sum(R), len(R)))
