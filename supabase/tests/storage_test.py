"""Storage isolation through the real Storage API: members reach only their vendor's folder."""
import os, sys, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import api_sb, sb_api as sb

RESULTS = []
def check(name, ok, obs=''):
    RESULTS.append(ok); print(('PASS ' if ok else 'FAIL ') + 'Storage :: ' + name + ('' if ok else '  -> ' + str(obs)[:200]))

def put(bucket, path, jwt, body=b'merchforce test'):
    req = urllib.request.Request('%s/storage/v1/object/%s/%s' % (sb.URL, bucket, path), data=body, method='POST',
          headers={'apikey': sb.ANON, 'Authorization': 'Bearer ' + (jwt or sb.ANON), 'Content-Type': 'text/plain', 'x-upsert': 'true'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status
    except urllib.error.HTTPError as e: return e.code

def get(bucket, path, jwt, public=False):
    url = '%s/storage/v1/object/%s%s/%s' % (sb.URL, 'public/' if public else '', bucket, path)
    req = urllib.request.Request(url, headers={'apikey': sb.ANON, 'Authorization': 'Bearer ' + (jwt or sb.ANON)})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status
    except urllib.error.HTTPError as e: return e.code

# a second vendor with its own member
plat = sb.sign_in(api_sb.USERS['platform']['email'], api_sb.USERS['platform']['password'])
if not sb.sql("select 1 from public.vendors where slug = 'mftest2'"):
    sb.rpc('platformVendorCreate', {'slug': 'mftest2', 'name': 'Merchforce TEST 2'}, plat)
v1 = sb.sql("select id from public.vendors where slug = 'mftest'")
v2 = sb.sql("select id from public.vendors where slug = 'mftest2'")
other_id = sb.sql("select id from auth.users where email = '%s'" % api_sb.USERS['other']['email'])
sb.sql("insert into public.vendor_members (vendor_id, user_id, role, name, email) values ('%s', '%s', 'admin', 'Other Admin', '%s') on conflict do nothing"
       % (v2, other_id, api_sb.USERS['other']['email']))

staff, other = api_sb.jwt('staff'), api_sb.jwt('other')
check('Staff can upload to their vendor folder', put('docs', '%s/test/hello.txt' % v1, staff) == 200)
check('Staff can read their vendor file', get('docs', '%s/test/hello.txt' % v1, staff) == 200)
code = put('docs', '%s/test/intrude.txt' % v2, staff)
check('Staff cannot upload into another vendor folder', code in (400, 403), code)
code = get('docs', '%s/test/hello.txt' % v1, other)
check('Another vendor cannot read the file', code in (400, 403, 404), code)
code = get('docs', '%s/test/hello.txt' % v1, None)
check('Signed-out visitor cannot read private docs', code in (400, 403, 404), code)
code = put('docs', 'no-vendor/x.txt', staff)
check('Upload outside any vendor folder refused', code in (400, 403), code)
check('Member can upload a product image', put('images', '%s/products/test.txt' % v1, staff) == 200)
check('Product images are publicly readable', get('images', '%s/products/test.txt' % v1, None, public=True) == 200)
code = put('images', '%s/products/x.txt' % v1, other)
check('Another vendor cannot write this vendor images', code in (400, 403), code)
print('%d/%d passed' % (sum(RESULTS), len(RESULTS)))
