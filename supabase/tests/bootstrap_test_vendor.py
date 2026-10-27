"""Create the 'mftest' vendor on the dev project: sign-ins, platform admin,
memberships, and the demo catalogue from tools/seed_products.json.

Idempotent: safe to re-run. Wipes nothing unless --reset is passed, which
deletes the mftest vendor and everything under it first (dev project only).
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sb_api as sb

HERE = os.path.dirname(os.path.abspath(__file__))
USERS = json.load(open(os.path.join(HERE, '.test-users.local')))
SLUG = 'mftest'

if '--reset' in sys.argv:
    sb.sql("delete from public.vendors where slug = '%s'" % SLUG)

ids = {k: sb.admin_user(u['email'], u['password']) for k, u in USERS.items()}
sb.sql("insert into public.platform_admins (user_id) values ('%s') on conflict do nothing" % ids['platform'])

plat = sb.sign_in(USERS['platform']['email'], USERS['platform']['password'])
if not sb.sql("select 1 from public.vendors where slug = '%s'" % SLUG):
    r = sb.rpc('platformVendorCreate', {'slug': SLUG, 'name': 'Merchforce TEST'}, plat)
    assert r.get('ok'), r
vid = sb.sql("select id from public.vendors where slug = '%s'" % SLUG)
for key, role, name in (('owner', 'admin', 'Test Owner'), ('staff', 'staff', 'Test Staff')):
    sb.sql("insert into public.vendor_members (vendor_id, user_id, role, name, email) values ('%s', '%s', '%s', '%s', '%s') "
           "on conflict (vendor_id, user_id) do update set role = excluded.role, name = excluded.name, active = true"
           % (vid, ids[key], role, name, USERS[key]['email']))

owner = sb.sign_in(USERS['owner']['email'], USERS['owner']['password'])
# the test vendor never sends real email (the suite would send ~50 per run)
assert sb.rpc('adminSettings', {'vendor': SLUG, 'save': {'mail_mode': 'off'}}, owner).get('ok')
seed = json.load(open(os.path.join(HERE, '..', '..', 'tools', 'seed_products.json')))
have = {p['sku'] for p in sb.rpc('adminCatalog', {'vendor': SLUG}, owner)['products']}
for b in seed['brands']:
    r = sb.rpc('adminBrandSave', {'vendor': SLUG, 'brand': {'id': b['id'], 'name': b['name'], 'sort': b.get('sort', 0)}}, owner)
    assert r.get('ok'), r
made = 0
for p in seed['products']:
    if p['sku'].upper() in have:
        continue
    stock = int(p.get('stock') or 0)
    r = sb.rpc('adminProductSave', {'vendor': SLUG, 'product': {
        'sku': p['sku'], 'name': p['name'], 'brand_id': p['brand_id'], 'category': p.get('category', ''),
        'subcategory': p.get('sub', ''), 'description': p.get('desc', ''), 'specs': '|'.join(p.get('specs') or []),
        'images': [p['image']] if p.get('image') else [], 'moq': p.get('moq', 1), 'gst_rate': 18,
        'hsn': p.get('hsn', ''), 'mrp': p.get('mrp', ''), 'lead_time': p.get('lead', ''),
        'on_hand': stock, 'safety_stock': round(stock * 0.03), 'reorder_point': round(stock * 0.1),
        'visible': True, 'show_price': True,
        'tiers': [{'min': t[0], 'price': t[1]} for t in (p.get('tiers') or [])]}}, owner)
    assert r.get('ok'), (p['sku'], r)
    made += 1
print('vendor %s ready: %d brands, %d products added, %d total' % (
    SLUG, len(seed['brands']), made, len(sb.rpc('adminCatalog', {'vendor': SLUG}, owner)['products'])))
