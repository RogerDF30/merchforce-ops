"""Merchforce workflow tests against the TEST backend.

Each check records PASS / FAIL with what was observed. A failing check never
stops the run: later workflows still execute so one bug doesn't hide others.
"""
import base64, json, sys, time
sys.path.insert(0, __import__('os').path.dirname(__file__))
from api import call, admin, TOKEN

RESULTS = []
CTX = {}
CUSTOMER = 'roger+mftest@companystore.io'
PDF = base64.b64encode(b'%PDF-1.4\n% Merchforce test PO\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').decode()


def check(area, name, cond, observed=''):
    RESULTS.append({'area': area, 'name': name, 'pass': bool(cond), 'observed': str(observed)[:400]})
    print(('PASS ' if cond else 'FAIL ') + area + ' :: ' + name + ('' if cond else '  -> ' + str(observed)[:300]), flush=True)


def product(sku):
    for p in admin('adminCatalog')['products']:
        if p['sku'] == sku:
            return p


def order(oid):
    for o in admin('adminOrders')['orders']:
        if o['id'] == oid:
            return o


def new_request(sku, qty, sess=None, **extra):
    body = dict(company='TEST Co ' + sku, contact='Test Buyer', email=CUSTOMER,
                gstin='29ABCDE1234F1Z5', lines=[{'sku': sku, 'qty': qty}], **extra)
    if sess:
        return call('adminRequestCreate', session=sess, **body)
    return admin('adminRequestCreate', **body)


def to_pi_sent(oid, sku, qty, price, sess=None):
    auth = {'session': sess} if sess else {}
    fn = (lambda a, **b: call(a, **auth, **b)) if sess else admin
    d = fn('adminRequestDecide', id=oid, accept=True)
    p = fn('adminPiBuild', id=oid, lines=[{'sku': sku, 'qty': qty, 'unit_price': price, 'gst': 18}],
           freight=500, discount=0, place_of_supply='29')
    return d, p


# ------------------------------------------------------------------ auth
def t_auth():
    A = 'Auth & access'
    check(A, 'Health check answers', call('x', token='nope').get('error') == 'Bad token')
    r = call('adminCatalog', adminKey='wrong')
    check(A, 'Wrong admin key is refused', not r.get('ok'), r)
    r = admin('adminSettings', save={'notify_email': 'roger@companystore.io', 'co_state_code': '29',
                                     'co_name': 'Merchforce TEST Pvt Ltd', 'co_gstin': '29AAAAA0000A1Z5'})
    check(A, 'Master key can save settings', r.get('ok'), r)
    r = admin('adminUserSave', user={'email': 'roger+staff@companystore.io', 'name': 'Test Staff',
                                     'password': 'short', 'role': 'staff'})
    check(A, 'Weak staff password rejected', not r.get('ok') and '10+' in r.get('error', ''), r)
    for email, name, role in [('roger+staff@companystore.io', 'Test Staff', 'staff'),
                              ('roger+owner@companystore.io', 'Test Owner', 'admin')]:
        r = admin('adminUserSave', user={'email': email, 'name': name, 'password': 'mf-test-pass-2026', 'role': role})
        check(A, 'Create %s account' % role, r.get('ok'), r)
    r = call('staffLogin', email='roger+staff@companystore.io', password='wrong-password-x')
    check(A, 'Wrong staff password refused', not r.get('ok'), r)
    r = call('staffLogin', email='roger+staff@companystore.io', password='mf-test-pass-2026')
    CTX['staff'] = r.get('session')
    check(A, 'Staff can sign in and gets a session', r.get('ok') and CTX['staff'], r)
    r = call('staffLogin', email='roger+owner@companystore.io', password='mf-test-pass-2026')
    CTX['owner'] = r.get('session')
    r = call('adminSettings', session=CTX['staff'])
    check(A, 'Staff role cannot open Settings (admin only)', not r.get('ok'), r)
    r = call('adminSettings', session=CTX['owner'])
    check(A, 'Admin role can open Settings', r.get('ok'), r.get('error'))
    r = call('adminCatalog', session='forged.token')
    check(A, 'Forged session refused', not r.get('ok'), r)


# ------------------------------------------------------- enquiry creation
def t_enquiry():
    A = 'Enquiry creation'
    sku = 'URBAN-294'
    r = admin('adminRequestCreate', company='X', contact='', email=CUSTOMER, lines=[{'sku': sku, 'qty': 25}])
    check(A, 'Missing contact rejected', not r.get('ok'), r)
    r = admin('adminRequestCreate', company='X', contact='Y', email='not-an-email', lines=[{'sku': sku, 'qty': 25}])
    check(A, 'Invalid email rejected', not r.get('ok'), r)
    r = new_request(sku, 10)
    check(A, 'Below-MOQ quantity rejected (MOQ 25)', not r.get('ok') and 'minimum' in r.get('error', ''), r)
    r = new_request('NO-SUCH-SKU', 50)
    check(A, 'Unknown SKU rejected', not r.get('ok'), r)
    r = new_request(sku, 100, sess=CTX['staff'])
    check(A, 'Staff can raise an enquiry', r.get('ok'), r)
    oid = r.get('request_id'); CTX['main'] = oid
    check(A, 'Tier price applied (100 units -> 852/unit)', r.get('total_est') == 85200, r)
    o = order(oid)
    check(A, 'Enquiry starts as New', o and o['status'] == 'New', o and o['status'])
    check(A, 'raised_by records the staff member', o and o['raised_by'] == 'Test Staff', o and o['raised_by'])
    check(A, 'Follow-up owner defaults to whoever raised it',
          o and o['assigned_to'] == 'roger+staff@companystore.io', o and o['assigned_to'])
    r = admin('adminRequestAssign', id=oid, assigned_to='roger+owner@companystore.io')
    o = order(oid)
    check(A, 'Follow-up owner can be reassigned', r.get('ok') and o['assigned_to'] == 'roger+owner@companystore.io', r)
    r = admin('adminRequestAssign', id=oid, assigned_to='nobody@example.com')
    check(A, 'Reassign to unknown person rejected', not r.get('ok'), r)


# ------------------------------------------ the happy path, end to end
def t_happy_path():
    A = 'Order lifecycle (happy path)'
    oid, sku, qty = CTX['main'], 'URBAN-294', 100
    before = product(sku)
    d, p = to_pi_sent(oid, sku, qty, 840)
    check(A, 'Accept enquiry -> Accepted', d.get('ok') and d.get('status') == 'Accepted', d)
    check(A, 'Build + send PI -> PI Sent', p.get('ok') and p.get('status') == 'PI Sent', p)
    check(A, 'PI number issued', bool(p.get('pi_number')), p)
    check(A, 'PI PDF link created', any(s in str(p.get('pi_url')) for s in ('drive.google.com', '/storage/v1/object/sign/')), p.get('pi_url'))
    # 100 x 840 = 84000, +18% GST = 99120, + 500 freight = 99620
    check(A, 'PI total = lines + GST + freight (99,620)', p.get('pi_total') == 99620, p.get('pi_total'))
    o = order(oid); CTX['token'] = o['token']
    check(A, 'Negotiated price overrides list price on the order', o['lines'][0]['unit_price'] == 840, o['lines'])
    check(A, 'List price kept for reference', o['lines'][0]['list_price'] == 852, o['lines'])
    mid = product(sku)
    check(A, 'No stock held before the PI is accepted', mid['reserved'] == before['reserved'], (before['reserved'], mid['reserved']))

    # customer page
    v = call('orderView', t=o['token'])
    check(A, 'Customer link opens the order', v.get('ok') and v['order']['id'] == oid, v.get('error'))
    leaked = [k for k in ('admin_notes', 'stock_state', 'token', 'folder_id', 'raised_by', 'assigned_to') if k in v.get('order', {})]
    check(A, 'Customer view hides internal fields', not leaked, leaked)
    r = call('orderView', t='x' * 28)
    check(A, 'Wrong order token refused', not r.get('ok'), r)
    r = call('orderPoUpload', t=o['token'], data=PDF, filename='po.pdf')
    check(A, 'PO before PI acceptance refused', not r.get('ok'), r)

    r = call('orderPiRespond', t=o['token'], accept=True, note='Looks good')
    check(A, 'Customer accepts PI -> PI Accepted', r.get('ok') and r.get('status') == 'PI Accepted', r)
    after_acc = product(sku)
    check(A, 'PI Accepted RESERVES stock (+100 reserved)', after_acc['reserved'] == before['reserved'] + qty,
          (before['reserved'], after_acc['reserved']))
    check(A, 'PI Accepted leaves on-hand unchanged', after_acc['on_hand'] == before['on_hand'], (before['on_hand'], after_acc['on_hand']))
    r = call('orderPiRespond', t=o['token'], accept=True)
    check(A, 'Second PI decision refused', not r.get('ok'), r)

    r = call('orderPoUpload', t=o['token'], data=PDF, filename='po.pdf', po_number='PO-TEST-001')
    check(A, 'Customer uploads PO -> PO Received', r.get('ok') and r.get('status') == 'PO Received', r)
    after_po = product(sku)
    check(A, 'PO Received DEDUCTS on-hand (-100)', after_po['on_hand'] == before['on_hand'] - qty, (before['on_hand'], after_po['on_hand']))
    check(A, 'PO Received clears the reservation', after_po['reserved'] == before['reserved'], (before['reserved'], after_po['reserved']))

    r = admin('adminRequestUpdate', id=oid, status='In Production')
    check(A, 'Move to In Production', r.get('ok') and r.get('status') == 'In Production', r)
    r = admin('adminShipmentSave', id=oid, shipment={'qty': 60, 'carrier': 'Delhivery', 'tracking': 'TEST123'})
    check(A, 'Part shipment -> Dispatched', r.get('ok') and r.get('status') == 'Dispatched', r)
    r = admin('adminShipmentSave', id=oid, shipment={'qty': 40, 'carrier': 'Delhivery', 'tracking': 'TEST124'})
    r = admin('adminShipmentSave', id=oid, shipment={'shipment_no': 1, 'qty': 60, 'status': 'Delivered'})
    check(A, 'One of two delivered -> still Dispatched', r.get('ok') and r.get('status') == 'Dispatched', r)
    r = admin('adminShipmentSave', id=oid, shipment={'shipment_no': 2, 'qty': 40, 'status': 'Delivered'})
    check(A, 'All shipments delivered -> Delivered', r.get('ok') and r.get('status') == 'Delivered', r)
    v = call('orderView', t=o['token'])
    check(A, 'Customer sees both shipments with tracking', len(v['order']['shipments']) == 2, v['order'].get('shipments'))
    r = admin('adminRequestUpdate', id=oid, status='Closed')
    check(A, 'Close the order', r.get('ok') and r.get('status') == 'Closed', r)
    final = product(sku)
    check(A, 'Closing does not move stock again', final['on_hand'] == after_po['on_hand'], (after_po['on_hand'], final['on_hand']))
    o = order(oid)
    check(A, 'Every stage is timestamped', all(s in o['status_dates'] for s in
          ['New', 'Accepted', 'PI Sent', 'PI Accepted', 'PO Received', 'In Production', 'Dispatched', 'Delivered', 'Closed']),
          list(o['status_dates'].keys()))


# --------------------------------------------------------- side branches
def t_branches():
    A = 'Branches & stock release'
    # 1. customer declines
    sku = 'UG-DB59'
    r = new_request(sku, 50); oid = r['request_id']
    before = product(sku)
    to_pi_sent(oid, sku, 50, 500)
    t = order(oid)['token']
    r = call('orderPiRespond', t=t, accept=False, note='Too expensive')
    check(A, 'Customer declines PI -> Declined', r.get('ok') and r.get('status') == 'Declined', r)
    check(A, 'Decline holds no stock', product(sku)['reserved'] == before['reserved'])
    check(A, 'Decline note lands in admin notes', 'Too expensive' in (order(oid)['admin_notes'] or ''), order(oid)['admin_notes'])

    # 2. supplier rejects a fresh enquiry
    r = new_request(sku, 50); oid = r['request_id']
    r = admin('adminRequestDecide', id=oid, accept=False, note='Out of range')
    check(A, 'Reject a new enquiry -> Rejected', r.get('ok') and r.get('status') == 'Rejected', r)

    # 3. cancel AFTER PI Accepted, using the console's status dropdown (adminRequestUpdate)
    sku = 'URBAN-298'
    r = new_request(sku, 50); oid = r['request_id']
    before = product(sku)
    to_pi_sent(oid, sku, 50, 500)
    call('orderPiRespond', t=order(oid)['token'], accept=True)
    held = product(sku)
    check(A, 'Setup: PI accepted holds 50', held['reserved'] == before['reserved'] + 50, (before['reserved'], held['reserved']))
    r = admin('adminRequestUpdate', id=oid, status='Cancelled')
    check(A, 'Cancel from console dropdown accepted', r.get('ok'), r)
    after = product(sku)
    check(A, 'Cancelling a PI-Accepted order RELEASES its reservation', after['reserved'] == before['reserved'],
          'reserved before=%s held=%s after cancel=%s; stock_state=%s' % (before['reserved'], held['reserved'], after['reserved'], order(oid)['stock_state']))

    # 4. PO marked received from the console dropdown instead of by upload
    sku = '5324866820'
    r = new_request(sku, 50); oid = r['request_id']
    before = product(sku)
    to_pi_sent(oid, sku, 50, 500)
    call('orderPiRespond', t=order(oid)['token'], accept=True)
    r = admin('adminRequestUpdate', id=oid, status='PO Received')
    after = product(sku)
    check(A, 'PO Received via console dropdown DEDUCTS on-hand',
          after['on_hand'] == before['on_hand'] - 50,
          'on_hand %s -> %s, reserved %s -> %s, stock_state=%s' % (before['on_hand'], after['on_hand'], before['reserved'], after['reserved'], order(oid)['stock_state']))

    # 5. not enough stock to hold
    sku = '5324866819'
    p = product(sku)
    big = p['atp'] + 100
    big += (25 - big % 25) % 25
    r = new_request(sku, big); oid = r.get('request_id')
    check(A, 'Enquiry above available stock can still be raised (stock not checked until PI acceptance)', r.get('ok'), r)
    if oid:
        to_pi_sent(oid, sku, big, 500)
        r = call('orderPiRespond', t=order(oid)['token'], accept=True)
        check(A, 'Accepting a PI with too little stock is refused', not r.get('ok') and 'stock' in r.get('error', '').lower(), r)
        check(A, 'Refused acceptance leaves order in PI Sent', order(oid)['status'] == 'PI Sent', order(oid)['status'])


# ------------------------------------------------------------- accounts
def t_accounts():
    A = 'Accounts'
    r = admin('adminCompanySave', company={'name': 'TEST Account Pvt Ltd', 'gstin': '27abcde1234f1z5',
              'bill': {'line1': '1 Test Road', 'city': 'Mumbai', 'state': 'Maharashtra', 'pin': '400001', 'country': 'India'}})
    check(A, 'Create company', r.get('ok'), r); cid = r.get('id'); CTX['company'] = cid
    c = [x for x in admin('adminCompanies').get('companies', []) if x.get('company_id', x.get('id')) == cid]
    c = c[0] if c else {}
    check(A, 'GSTIN normalised to upper case', c.get('gstin') == '27ABCDE1234F1Z5', c.get('gstin'))
    check(A, 'State code derived from billing state (27)', str(c.get('state_code')) == '27', c.get('state_code'))
    r = admin('adminContactSave', contact={'company_id': cid, 'name': 'Test Contact', 'email': 'bad-email'})
    check(A, 'Contact with invalid email rejected', not r.get('ok'), r)
    r = admin('adminContactSave', contact={'company_id': cid, 'name': 'Test Contact', 'email': CUSTOMER, 'consent': True})
    check(A, 'Create contact with consent', r.get('ok'), r)
    r = admin('adminAccountNoteSave', company_id=cid, text='TEST note: called about Diwali order')
    check(A, 'Add dated account note', r.get('ok'), r)
    r = admin('adminAccountNotes', company_id=cid)
    check(A, 'Note reads back', r.get('ok') and any('Diwali' in n.get('text', '') for n in r.get('notes', [])), r)
    r = new_request('URBAN-294', 25, company_id=cid)
    r2 = admin('adminCompanyDelete', id=cid)
    check(A, 'Company with orders cannot be deleted', not r2.get('ok'), r2)


# -------------------------------------------------------- catalogue / HSN
def t_catalogue():
    A = 'Catalogue'
    base = {'sku': 'TEST-HSN', 'name': 'TEST HSN product', 'moq': 10, 'gst_rate': 18, 'on_hand': 100,
            'visible': True, 'show_price': True}
    r = admin('adminProductSave', product=dict(base, tiers=[{'min': 20, 'price': 100}]))
    check(A, 'First tier must start at MOQ', not r.get('ok'), r)
    r = admin('adminProductSave', product=dict(base, hsn='0902', tiers=[{'min': 10, 'price': 100}]))
    check(A, 'Save product with HSN 0902', r.get('ok'), r)
    p = product('TEST-HSN')
    check(A, 'Leading-zero HSN survives (0902, not 902)', p and str(p.get('hsn')) == '0902', p and p.get('hsn'))


# ------------------------------------------------------------------ stock
def t_stock():
    A = 'Stock & supply'
    s = admin('adminStock')
    check(A, 'Stock screen loads', s.get('ok'), s.get('error'))
    CTX['stock'] = s
    sku = '9578398628'
    p0 = product(sku)
    r = admin('adminSupplySave', supply={'sku': sku, 'qty': 0})
    check(A, 'Zero-quantity supply order rejected', not r.get('ok'), r)
    r = admin('adminSupplySave', supply={'sku': sku, 'qty': 200, 'kind': 'buy', 'vendor': 'TEST Vendor'})
    check(A, 'Create purchase (buy) order', r.get('ok'), r)
    so = (r.get('supply') or {}).get('id')
    check(A, 'New supply order starts Planned', (r.get('supply') or {}).get('status') == 'Planned', r.get('supply'))
    CTX['so'] = so
    r = admin('adminSupplySave', supply={'id': so, 'status': 'Done'})
    check(A, 'Cannot mark Done before goods arrive', not r.get('ok'), r)
    r = admin('adminSupplyReceive', id=so, qty=120)
    p1 = product(sku)
    check(A, 'Partial receipt adds to on-hand (+120)', r.get('ok') and p1['on_hand'] == p0['on_hand'] + 120, (r, p0['on_hand'], p1['on_hand']))
    r = admin('adminSupplyReceive', id=so, qty=80)
    p2 = product(sku)
    check(A, 'Final receipt completes the order', r.get('ok') and p2['on_hand'] == p0['on_hand'] + 200, (r, p2['on_hand']))
    r = admin('adminSupplySave', supply={'id': so, 'status': 'Open'})
    check(A, 'Completed supply order cannot be reopened', not r.get('ok'), r)
    r = admin('adminSupplyReceive', id=so, qty=10)
    check(A, 'Cannot receive against a completed order', not r.get('ok'), r)

    # reorder rule: push a product below its reorder point and read the suggestion
    sku = '6111990716'
    p = product(sku)
    r = admin('adminProductSave', product={'sku': sku, 'name': p['name'], 'moq': p['moq'], 'gst_rate': p['gst_rate'],
              'hsn': p['hsn'], 'on_hand': p['reorder_point'] - 10, 'safety_stock': p['safety_stock'],
              'reorder_point': p['reorder_point'], 'visible': True, 'show_price': True, 'images': p['images'],
              'brand_id': p['brand_id'], 'category': p['category'], 'specs': p['specs'], 'description': p['description'],
              'lead_time': p['lead_time'], 'mrp': p['mrp'], 'tiers': p['tiers']})
    s = admin('adminStock')
    row = [x for x in s.get('reorder', []) if x['sku'] == sku]
    check(A, 'Product below reorder point appears on Reorder list', bool(row), [x['sku'] for x in s.get('reorder', [])][:10])
    if row:
        row = row[0]
        check(A, 'Suggested qty is a whole number of lots', row['suggest_qty'] > 0 and row['suggest_qty'] % row['lot'] == 0, row)
    fq = s.get('queue') or s.get('fulfilment') or []
    check(A, 'Fulfilment queue lists open orders from PO Received onward',
          all(x.get('status') in ('PO Received', 'In Production', 'Dispatched') for x in fq), [x.get('status') for x in fq])


# ---------------------------------------------------- fix regressions
def t_regressions():
    A = 'Regression (fixes)'
    # Bug 1: enquiry creation writes exactly one record and reports success
    n0 = len(admin('adminOrders')['orders'])
    r = new_request('UG 02', 25)
    n1 = len(admin('adminOrders')['orders'])
    check(A, 'Enquiry create returns ok and writes exactly one record', r.get('ok') and n1 == n0 + 1, (r, n0, n1))
    oid = r.get('request_id')

    # Bug 2: console dropdown — notes alone, notes kept when a status change is refused
    r = admin('adminRequestUpdate', id=oid, admin_notes='TEST note only')
    o = order(oid)
    check(A, 'Notes-only update saves and leaves status alone', r.get('ok') and o['admin_notes'] == 'TEST note only' and o['status'] == 'New', (r, o['status']))
    r = admin('adminRequestUpdate', id=oid, status='Bogus', admin_notes='TEST kept')
    check(A, 'Unknown status refused', not r.get('ok'), r)
    check(A, 'Notes still saved when the status change is refused', order(oid)['admin_notes'] == 'TEST kept', order(oid)['admin_notes'])

    # dropdown walk with stock: PI Accepted -> Cancelled releases; PO Received deducts; Cancel after deduct refused
    sku = 'UG 02'
    before = product(sku)
    to_pi_sent(oid, sku, 25, 500)
    call('orderPiRespond', t=order(oid)['token'], accept=True)
    r = admin('adminRequestUpdate', id=oid, status='PO Received')
    after = product(sku)
    check(A, 'Dropdown PO Received after acceptance deducts once (-25 on hand, reservation cleared)',
          r.get('ok') and after['on_hand'] == before['on_hand'] - 25 and after['reserved'] == before['reserved'],
          (before['on_hand'], after['on_hand'], before['reserved'], after['reserved']))
    r = admin('adminRequestUpdate', id=oid, status='Dispatched')
    again = product(sku)
    check(A, 'Moving on to Dispatched does not deduct a second time', again['on_hand'] == after['on_hand'], (after['on_hand'], again['on_hand']))
    r = admin('adminRequestUpdate', id=oid, status='Cancelled')
    check(A, 'Cancelling after the goods shipped is refused (record the return in the catalogue)',
          not r.get('ok') and 'shipped' in r.get('error', ''), r)
    check(A, 'Refused cancel leaves the order Dispatched and stock untouched',
          order(oid)['status'] == 'Dispatched' and product(sku)['on_hand'] == again['on_hand'], order(oid)['status'])

    # cancel while still in house: deducted stock comes back
    for stage in ('PO Received', 'In Production'):
        r = new_request(sku, 25); oc = r['request_id']
        b = product(sku)
        admin('adminRequestUpdate', id=oc, status='PO Received')
        if stage == 'In Production':
            admin('adminRequestUpdate', id=oc, status='In Production')
        mid = product(sku)
        r = admin('adminRequestUpdate', id=oc, status='Cancelled')
        a = product(sku)
        check(A, 'Cancel at %s returns the deducted stock (+25 on hand)' % stage,
              r.get('ok') and mid['on_hand'] == b['on_hand'] - 25 and a['on_hand'] == b['on_hand'] and a['reserved'] == b['reserved'],
              (r, b['on_hand'], mid['on_hand'], a['on_hand']))
        o = order(oc)
        check(A, 'Cancelled order at %s has no stock state left' % stage, o['status'] == 'Cancelled' and o['stock_state'] == '', (o['status'], o['stock_state']))

    # dropdown jump straight from New to PO Received (PO arrived by email, no PI in system)
    r = new_request(sku, 25); oid2 = r['request_id']
    b2 = product(sku)
    r = admin('adminRequestUpdate', id=oid2, status='PO Received')
    a2 = product(sku)
    check(A, 'New -> PO Received by dropdown deducts stock once', r.get('ok') and a2['on_hand'] == b2['on_hand'] - 25 and a2['reserved'] == b2['reserved'],
          (r, b2['on_hand'], a2['on_hand'], a2['reserved']))

    # Bug 3: HSN as text — product master, order lines, PI
    r = new_request('TEST-HSN', 10)
    oid3 = r.get('request_id')
    o3 = order(oid3) if oid3 else None
    check(A, 'Order line snapshots HSN 0902 as text', o3 and str(o3['lines'][0]['hsn']) == '0902', o3 and o3['lines'])
    if oid3:
        p = admin('adminPiBuild', id=oid3, lines=[{'sku': 'TEST-HSN', 'qty': 10, 'unit_price': 100, 'gst': 5}], send=False)
        o3 = order(oid3)
        check(A, 'HSN still 0902 after the PI rewrites the lines', str(o3['lines'][0]['hsn']) == '0902', o3['lines'])
    p = product('TEST-HSN')
    r = admin('adminProductSave', product={'sku': 'TEST-HSN', 'name': p['name'], 'moq': p['moq'], 'gst_rate': p['gst_rate'],
              'hsn': p['hsn'], 'on_hand': p['on_hand'], 'visible': True, 'show_price': True, 'tiers': p['tiers']})
    check(A, 'Re-saving the product keeps 0902', str(product('TEST-HSN')['hsn']) == '0902', product('TEST-HSN')['hsn'])


# ---------------------------------------------------------------- returns
def delivered_order(sku, q, price=500):
    oid = new_request(sku, q)['request_id']
    to_pi_sent(oid, sku, q, price)
    tok = order(oid)['token']
    call('orderPiRespond', t=tok, accept=True)
    call('orderPoUpload', t=tok, data=PDF, filename='po.pdf')
    admin('adminShipmentSave', id=oid, shipment={'qty': q, 'status': 'Delivered'})
    return oid


def rma(rid):
    return [x for x in admin('adminReturns')['returns'] if x['id'] == rid][0]


def t_returns():
    A = 'Returns'
    sku = 'URBAN-294'
    oid = delivered_order(sku, 50)
    check(A, 'Setup: order delivered', order(oid)['status'] == 'Delivered', order(oid)['status'])
    fresh = new_request(sku, 25)['request_id']

    r = admin('adminReturnCreate', request_id=fresh, reason='Damaged', lines=[{'sku': sku, 'qty': 5}])
    check(A, 'Return on an unshipped order refused', not r.get('ok') and 'shipped' in r.get('error', ''), r)
    r = admin('adminReturnCreate', request_id=oid, reason='Because', lines=[{'sku': sku, 'qty': 5}])
    check(A, 'Return without a valid reason refused', not r.get('ok'), r)
    r = admin('adminReturnCreate', request_id=oid, reason='Damaged', lines=[{'sku': 'UG 02', 'qty': 5}])
    check(A, 'SKU not on the order refused', not r.get('ok'), r)
    r = admin('adminReturnCreate', request_id=oid, reason='Damaged', lines=[{'sku': sku, 'qty': 51}])
    check(A, 'More than was ordered refused', not r.get('ok') and 'at most 50' in r.get('error', ''), r)
    r = admin('adminReturnCreate', request_id=oid, reason='Damaged', lines=[{'sku': sku, 'qty': 0}])
    check(A, 'Return with no quantities refused', not r.get('ok'), r)

    r = admin('adminReturnCreate', request_id=oid, reason='Damaged', note='TEST 20 cracked', lines=[{'sku': sku, 'qty': 20}])
    check(A, 'Log a return -> Requested', r.get('ok') and rma(r['id'])['status'] == 'Requested', r)
    r1 = r.get('id')
    x = rma(r1)
    check(A, 'Return records who logged it', x['created_by'] in ('master', 'Test Owner'), x['created_by'])
    r = admin('adminReturnCreate', request_id=oid, reason='Excess / not needed', lines=[{'sku': sku, 'qty': 31}])
    check(A, 'Open returns count against what is left (30 max)', not r.get('ok') and 'at most 30' in r.get('error', ''), r)
    r2 = admin('adminReturnCreate', request_id=oid, reason='Excess / not needed', lines=[{'sku': sku, 'qty': 30}]).get('id')
    r = admin('adminReturnUpdate', id=r2, status='Rejected')
    check(A, 'Reject a return', r.get('ok') and rma(r2)['status'] == 'Rejected', r)
    r = admin('adminReturnUpdate', id=r2, status='Approved')
    check(A, 'Rejected return cannot be reopened', not r.get('ok'), r)

    r = admin('adminReturnReceive', id=r1, lines=[{'sku': sku, 'restocked': 20, 'scrapped': 0}])
    check(A, 'Cannot receive before approval', not r.get('ok') and 'Approve' in r.get('error', ''), r)
    r = admin('adminReturnUpdate', id=r1, status='Received')
    check(A, 'Cannot jump to Received by status', not r.get('ok'), r)
    r = admin('adminReturnUpdate', id=r1, status='Approved', carrier='Delhivery', tracking='RET123')
    x = rma(r1)
    check(A, 'Approve with return carrier and tracking', r.get('ok') and x['status'] == 'Approved' and x['tracking'] == 'RET123', x)

    before = product(sku)
    r = admin('adminReturnReceive', id=r1, lines=[{'sku': sku, 'restocked': 10, 'scrapped': 5}])
    check(A, 'Every unit must be restocked or scrapped', not r.get('ok') and 'must equal' in r.get('error', ''), r)
    check(A, 'Refused receipt moves no stock', product(sku)['on_hand'] == before['on_hand'])
    r = admin('adminReturnReceive', id=r1, lines=[{'sku': sku, 'restocked': 15, 'scrapped': 5}])
    after = product(sku)
    check(A, 'Receive -> Received, restocked units back on hand (+15)',
          r.get('ok') and rma(r1)['status'] == 'Received' and after['on_hand'] == before['on_hand'] + 15,
          (r, before['on_hand'], after['on_hand']))
    check(A, 'Scrapped units do not return to stock', after['on_hand'] - before['on_hand'] == 15)
    check(A, 'Restock does not touch reservations', after['reserved'] == before['reserved'])
    x = rma(r1)
    check(A, 'Inspection result stored per line', x['lines'][0]['restocked'] == 15 and x['lines'][0]['scrapped'] == 5, x['lines'])

    r = admin('adminReturnClose', id=r1, resolution='')
    check(A, 'Close without a resolution refused', not r.get('ok'), r)
    r = admin('adminReturnClose', id=r1, resolution='Credit note')
    check(A, 'Credit note without an amount refused', not r.get('ok') and 'amount' in r.get('error', ''), r)
    r = admin('adminReturnClose', id=r1, resolution='Credit note', amount=11800, ref='CN-TEST-01',
              data=PDF, filename='credit-note.pdf')
    x = rma(r1)
    check(A, 'Close with credit note -> Closed, amount, ref, document',
          r.get('ok') and x['status'] == 'Closed' and x['amount'] == 11800 and x['ref'] == 'CN-TEST-01' and any(s in x['doc_url'] for s in ('drive.google.com', '/storage/v1/object/sign/')), x)
    r = admin('adminReturnUpdate', id=r1, note='late edit')
    check(A, 'Closed return is locked', not r.get('ok'), r)
    check(A, 'Every return stage is timestamped', all(s in x['status_dates'] for s in ('Requested', 'Approved', 'Received', 'Closed')), x['status_dates'])

    # refund and no-resolution paths on what is left of the same order (30 units)
    for res, amt in (('Refund', 2500), ('None', 0)):
        rid = admin('adminReturnCreate', request_id=oid, reason='Wrong item', lines=[{'sku': sku, 'qty': 5}])['id']
        admin('adminReturnUpdate', id=rid, status='Approved')
        admin('adminReturnReceive', id=rid, lines=[{'sku': sku, 'restocked': 5, 'scrapped': 0}])
        r = admin('adminReturnClose', id=rid, resolution=res, amount=amt, ref='TEST-' + res)
        x = rma(rid)
        check(A, 'Close with %s' % res, r.get('ok') and x['resolution'] == res and x['amount'] == amt, (r, x['resolution'], x['amount']))

    # replacement: scrapped goods, new zero-value order that deducts stock
    sku2 = 'UG-DB59'
    oid2 = delivered_order(sku2, 25)
    rid = admin('adminReturnCreate', request_id=oid2, reason='Refused at delivery', lines=[{'sku': sku2, 'qty': 25}])['id']
    admin('adminReturnUpdate', id=rid, status='Approved')
    b = product(sku2)
    admin('adminReturnReceive', id=rid, lines=[{'sku': sku2, 'restocked': 0, 'scrapped': 25}])
    check(A, 'All-scrapped receipt leaves stock alone', product(sku2)['on_hand'] == b['on_hand'])
    r = admin('adminReturnClose', id=rid, resolution='Replacement')
    rep = r.get('replacement_id')
    check(A, 'Close with replacement creates a linked order', r.get('ok') and rep, r)
    if rep:
        o = order(rep); a = product(sku2)
        check(A, 'Replacement order starts at PO Received, zero value', o['status'] == 'PO Received' and o['lines'][0]['unit_price'] == 0 and o['lines'][0]['qty'] == 25, (o['status'], o['lines']))
        check(A, 'Replacement deducts stock (-25)', a['on_hand'] == b['on_hand'] - 25, (b['on_hand'], a['on_hand']))
        check(A, 'Replacement names its return', rid in (o['notes'] or ''), o['notes'])
        check(A, 'Replacement ships like any order', admin('adminShipmentSave', id=rep, shipment={'qty': 25}).get('status') == 'Dispatched')
    check(A, 'Returns list filters by order', [x['id'] for x in admin('adminReturns', request_id=oid2)['returns']] == [rid])


# ------------------------------------------------------------ decks etc.
def t_decks_analytics():
    A = 'Decks & analytics'
    r = admin('adminDeckBuild', name='TEST deck', skus=['URBAN-294', 'UG 02', 'UG-DB59'])
    check(A, 'Build deck (PDF + PPTX)', r.get('ok') and r.get('pdf_url') and r.get('pptx_url'), r)
    check(A, 'Deck includes all 3 products', r.get('products') == 3, r.get('products'))
    r = admin('adminDeckBuild', name='TEST deck', skus=[])
    check(A, 'Empty deck rejected', not r.get('ok'), r)
    r = admin('adminAnalytics', days=30)
    check(A, 'Analytics loads', r.get('ok'), r.get('error'))
    CTX['analytics_keys'] = list(r.keys())


if __name__ == '__main__':
    t0 = time.time()
    for t in (t_auth, t_enquiry, t_happy_path, t_branches, t_accounts, t_catalogue, t_stock, t_regressions, t_returns, t_decks_analytics):
        try:
            t()
        except Exception as e:
            check(t.__name__, 'crashed', False, repr(e))
    json.dump({'results': RESULTS, 'ctx': {k: v for k, v in CTX.items() if k not in ('staff', 'owner', 'token', 'stock')}},
              open(__import__('os').path.join(__import__('os').path.dirname(__file__), 'results.json'), 'w'), indent=1, default=str)
    n = sum(r['pass'] for r in RESULTS)
    print('\n%d/%d passed in %ds' % (n, len(RESULTS), time.time() - t0))
