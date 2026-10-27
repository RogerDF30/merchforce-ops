"""Console actions not covered by the shared workflow suite: document uploads,
account files, product images, sheet preview, manual mappings, write-back-all.

Needs the test sheet shared (Editor) with the service account:
    python3 -I supabase/tests/phase3_actions_test.py [sheet_id]
"""
import base64, os, sys, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import api_sb, sb_api as sb

SHEET = sys.argv[1] if len(sys.argv) > 1 else '1mPBmbb9514kYh2ayXVvd6SB9TK446Ml_e_G9CZkGi98'
A = api_sb.admin
RESULTS = []
PDF = 'data:application/pdf;base64,' + base64.b64encode(b'%PDF-1.4\n% Merchforce test\n%%EOF').decode()
PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='


def check(area, name, ok, obs=''):
    RESULTS.append(bool(ok))
    print(('PASS ' if ok else 'FAIL ') + area + ' :: ' + name + ('' if ok else '  -> ' + str(obs)[:240]))


def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return r.status, r.headers.get('content-type', ''), r.read()
    except urllib.error.HTTPError as e:
        return e.code, '', b''


def order(oid):
    return next(o for o in A('adminOrders')['orders'] if o['id'] == oid)


def new_order(sku='URBAN-294', qty=25):
    return A('adminRequestCreate', company='TEST docs', contact='T', email='roger+mftest@companystore.io',
             lines=[{'sku': sku, 'qty': qty}])['request_id']


# ---------------------------------------------------------------- documents from the console
D = 'Documents'
oid = new_order()
A('adminRequestDecide', id=oid, accept=True)
r = A('adminPiUpload', id=oid, filename='Our PI 001.pdf', mime='application/pdf', data=PDF, pi_number='EXT-PI-001', pi_total=25000)
check(D, 'Upload a PI made elsewhere -> PI Sent', r.get('ok') and order(oid)['status'] == 'PI Sent', r)
o = order(oid)
check(D, 'Uploaded PI keeps its number and total', o['pi_number'] == 'EXT-PI-001' and o['pi_total'] == 25000, (o['pi_number'], o['pi_total']))
st, ctype, body = fetch(o['pi_url'])
check(D, 'Uploaded PI opens from its signed link', st == 200 and body.startswith(b'%PDF'), (st, ctype))
r = A('adminPiUpload', id=oid, filename='x.pdf', data='data:application/pdf;base64,' + base64.b64encode(b'0' * (10 * 1024 * 1024 + 10)).decode())
check(D, 'PI over 10 MB refused', not r.get('ok') and '10MB' in r.get('error', ''), r)

tok = o['token']
sb.rpc('orderPiRespond', {'t': tok, 'accept': True, 'vendor': api_sb.SLUG})
r = A('adminPoUpload', id=oid, filename='Customer PO.pdf', mime='application/pdf', data=PDF, po_number='CUST-PO-77')
o = order(oid)
check(D, 'Admin uploads a PO received by email -> PO Received', r.get('ok') and o['status'] == 'PO Received' and o['po_number'] == 'CUST-PO-77', (r, o['status']))
check(D, 'PO opens from its signed link', fetch(o['po_url'])[0] == 200)
v = sb.rpc('orderView', {'t': tok, 'vendor': api_sb.SLUG})
check(D, 'Customer page gets working PI and PO links', fetch(v['order']['pi_url'])[0] == 200 and fetch(v['order']['po_url'])[0] == 200)
check(D, 'Signed links expire (carry a token)', 'token=' in o['pi_url'], o['pi_url'][:80])

# ---------------------------------------------------------------- account files
F = 'Account files'
co = A('adminCompanySave', company={'name': 'TEST files account'})['id']
r = A('adminAccountFileUpload', company_id=co, filename='GST certificate.pdf', mime='application/pdf', data=PDF)
check(F, 'Upload an account file', r.get('ok') and r['file']['name'] == 'GST certificate.pdf', r)
fid = r.get('file', {}).get('id')
notes = A('adminAccountNotes', company_id=co)
f = next((x for x in notes.get('files', []) if x['id'] == fid), None)
check(F, 'File listed on the account with a working link', f and fetch(f['url'])[0] == 200, f)
path = f and f['path']
r = A('adminAccountFileDelete', id=fid)
gone = not any(x['id'] == fid for x in A('adminAccountNotes', company_id=co).get('files', []))
listing = sb._http('POST', '%s/storage/v1/object/list/docs' % sb.URL, {'prefix': path.rsplit('/', 1)[0] + '/', 'limit': 100},
                   {'apikey': sb.SERVICE, 'Authorization': 'Bearer ' + sb.SERVICE})[1] if path else []
still = any(path and path.endswith('/' + o['name']) for o in (listing or []))
check(F, 'Delete removes the record and the stored file', r.get('ok') and gone and not still, (r, gone, still))
r = sb.rpc('adminAccountFileUpload', {'vendor': api_sb.SLUG, 'company_id': co, 'filename': 'x.pdf', 'data': PDF}, None)
check(F, 'Signed-out upload refused', not r.get('ok'), r)

# ---------------------------------------------------------------- product images
I = 'Images'
r = A('adminImageUpload', filename='logo test.png', mime='image/png', data=PNG)
st, ctype, _ = fetch(r.get('url', ''))
check(I, 'Upload a product image -> public link that loads', r.get('ok') and st == 200 and ctype.startswith('image/'), (r, st, ctype))
r = A('adminImageUpload', filename='big.png', data='data:image/png;base64,' + base64.b64encode(b'0' * (4 * 1024 * 1024 + 10)).decode())
check(I, 'Image over 4 MB refused', not r.get('ok') and '4MB' in r.get('error', ''), r)

# ---------------------------------------------------------------- sheet preview & mappings
S = 'Sheet sync'
r = A('adminSyncPreview', sheet='https://docs.google.com/spreadsheets/d/%s/edit' % SHEET, tab='Stock')
check(S, 'Preview lists the tabs and the chosen tab\'s columns',
      r.get('ok') and 'Stock' in r['tabs'] and r['tab'] == 'Stock' and 'Code' in r['headers'] and 'Image URL' in r['headers'], r.get('error') or r.get('headers'))
check(S, 'Preview names the account to share with', r.get('owner_hint', '').endswith('.iam.gserviceaccount.com'), r.get('owner_hint'))
# a private sheet that is NOT shared with the service account (Google's public samples are readable by anyone)
r = A('adminSyncPreview', sheet='https://docs.google.com/spreadsheets/d/1Idpvwr01XnabzKi4a0Cts8lyMLw-TRDcL-cTwZWl3ec/edit')
check(S, 'Preview of an unshared sheet says to share it', not r.get('ok') and 'share it' in r.get('error', ''), r)

before = len(A('adminSettings')['settings']['sync_maps'] and __import__('json').loads(A('adminSettings')['settings']['sync_maps']))
r = A('adminSyncMapSave', map={'mode': 'pull', 'brand': '', 'sheet': SHEET, 'create_new': False, 'write_back': False,
                               'sources': [{'tab': 'Stock', 'sku_col': 'Code', 'fields': [{'col': 'Stock', 'field': 'on_hand'},
                                                                                         {'col': 'Bogus', 'field': 'not_a_field'}]}]})
maps = r.get('maps', [])
check(S, 'Save a manual mapping (unknown fields dropped)', r.get('ok') and len(maps) == before + 1
      and maps[-1]['sources'][0]['fields'] == [{'col': 'Stock', 'field': 'on_hand'}], r.get('error') or maps[-1:])
r = A('adminSyncMapSave', index=len(maps) - 1, map={'mode': 'pull', 'brand': '', 'sheet': SHEET, 'write_back': False,
      'sources': [{'tab': 'Stock', 'sku_col': 'Code', 'fields': [{'col': 'MOQ', 'field': 'moq'}]}]})
check(S, 'Edit a mapping in place', r.get('ok') and len(r['maps']) == before + 1 and r['maps'][-1]['sources'][0]['fields'][0]['field'] == 'moq', r.get('error'))
r = A('adminSyncMapSave', map={'mode': 'pull', 'sheet': SHEET, 'sources': [{'tab': 'Stock', 'sku_col': '', 'fields': []}]})
check(S, 'Mapping without a SKU column or fields refused', not r.get('ok') and 'required' in r.get('error', ''), r)
r = A('adminSyncMapSave', map={'mode': 'push', 'brand': 'BR-PARKER', 'sheet': SHEET})
check(S, 'Push mapping refused with a clear reason', not r.get('ok') and 'Push mappings' in r.get('error', ''), r)
r = A('adminSyncMapDelete', index=len(maps) - 1)
check(S, 'Delete a mapping', r.get('ok') and len(r['maps']) == before, r.get('error'))
r = sb.rpc('adminSyncMapSave', {'vendor': api_sb.SLUG, 'map': {'sheet': SHEET}}, api_sb.jwt('staff'))
check(S, 'Staff cannot change mappings (admin only)', not r.get('ok') and 'admin' in r.get('error', ''), r)

r = A('adminSyncWriteBackAll')
check(S, 'Write all stock to the sheet now', r.get('ok') and not r.get('errors'), r)
r = A('adminSyncSchedule', mode='nonsense')
check(S, 'Unknown schedule falls back to off', r.get('ok') and r.get('mode') == 'off', r)

print('%d/%d passed' % (sum(RESULTS), len(RESULTS)))
