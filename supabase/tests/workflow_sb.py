"""Run the shared workflow suite (tests/workflow_test.py) against Supabase.

Usage: python3 -I supabase/tests/workflow_sb.py [section ...]
Sections: catalogue accounts enquiry happy branches regressions returns stock decks
"""
import os, sys, json, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import api_sb
sys.modules['api'] = api_sb                       # the suite imports `api`; give it Supabase
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tests'))
import workflow_test as W
import sb_api as sb

W.CUSTOMER = 'roger+mftest@companystore.io'


def t_auth_sb():
    """Supabase sign-in replaces the master key and home-made sessions."""
    A = 'Auth & access'
    U = api_sb.USERS
    check = W.check
    r = W.call('staffLogin', email=U['staff']['email'], password='wrong-password-x')
    check(A, 'Wrong password refused', not r.get('ok'), r)
    r = W.call('staffLogin', email=U['staff']['email'], password=U['staff']['password'])
    W.CTX['staff'] = r.get('session')
    check(A, 'Staff can sign in and gets a session', r.get('ok') and W.CTX['staff'], r)
    W.CTX['owner'] = api_sb.jwt('owner')
    r = W.call('adminSettings', session=W.CTX['staff'])
    check(A, 'Staff role cannot open Settings (admin only)', not r.get('ok') and 'admin' in r.get('error', ''), r)
    r = W.call('adminSettings', session=W.CTX['owner'])
    check(A, 'Admin role can open Settings', r.get('ok'), r.get('error'))
    r = W.call('adminCatalog', session='forged.token.value')
    check(A, 'Forged session refused', not r.get('ok'), r)
    r = W.call('adminCatalog')
    check(A, 'Signed-out visitor refused', not r.get('ok'), r)
    other = api_sb.jwt('other')
    r = sb.rpc('adminCatalog', {'vendor': api_sb.SLUG}, other)
    check(A, 'Person from no vendor refused', not r.get('ok') and 'access' in r.get('error', ''), r)
    # staff accounts (admin-users edge function)
    new_email = 'roger+mfnew@companystore.io'
    r = W.admin('adminUserSave', user={'email': new_email, 'name': 'New Person', 'password': 'short', 'role': 'staff'})
    check(A, 'Weak staff password rejected', not r.get('ok') and '10+' in r.get('error', ''), r)
    r = W.admin('adminUserSave', user={'email': new_email, 'name': 'New Person', 'password': 'mf-new-pass-2026', 'role': 'staff', 'active': True})
    check(A, 'Admin creates a staff login', r.get('ok'), r)
    t = sb.sign_in(new_email, 'mf-new-pass-2026')
    check(A, 'New staff member can sign in', bool(t))
    r = sb.rpc('adminCatalog', {'vendor': api_sb.SLUG}, t)
    check(A, 'New staff member reaches the catalogue', r.get('ok'), r)
    r = sb.rpc('adminUserSave', {'vendor': api_sb.SLUG, 'user': {'email': 'roger+mfx@companystore.io', 'password': 'whatever-123'}}, W.CTX['staff'])
    check(A, 'Staff cannot create logins', not r.get('ok') and 'admin' in r.get('error', ''), r)
    users = W.admin('adminUsers').get('users', [])
    check(A, 'Users list shows the new person as staff', any(u['email'] == new_email and u['role'] == 'staff' for u in users), users)
    r = W.admin('adminUserSave', user={'email': new_email, 'password': 'mf-new-pass-2027'})
    check(A, 'Admin resets a staff password', r.get('ok') and bool(sb.sign_in(new_email, 'mf-new-pass-2027')), r)
    r = W.admin('adminUserSave', user={'email': new_email, 'active': False})
    r2 = sb.rpc('adminCatalog', {'vendor': api_sb.SLUG}, sb.sign_in(new_email, 'mf-new-pass-2027'))
    check(A, 'Deactivated person is locked out of the vendor', r.get('ok') and not r2.get('ok'), r2)
    other_email = api_sb.USERS['other']['email']
    W.admin('adminUserSave', user={'email': other_email, 'name': 'Shared Person', 'role': 'staff'})
    r = W.admin('adminUserSave', user={'email': other_email, 'password': 'takeover-attempt-1'})
    check(A, 'Cannot reset a password shared with another vendor', not r.get('ok') and 'another' in r.get('error', ''), r)
    W.admin('adminUserSave', user={'email': other_email, 'active': False})
    r = W.admin('adminSettings', save={'notify_email': 'roger@companystore.io', 'co_state_code': '29',
                                       'co_name': 'Merchforce TEST Pvt Ltd', 'co_gstin': '29AAAAA0000A1Z5'})
    check(A, 'Admin can save settings', r.get('ok'), r)


SECTIONS = {
    'catalogue': W.t_catalogue, 'accounts': W.t_accounts,
    'enquiry': W.t_enquiry, 'happy': W.t_happy_path, 'branches': W.t_branches,
    'regressions': W.t_regressions, 'returns': W.t_returns, 'stock': W.t_stock, 'decks': W.t_decks_analytics,
}

if __name__ == '__main__':
    t0 = time.time()
    t_auth_sb()
    for name in (sys.argv[1:] or list(SECTIONS)):
        try:
            SECTIONS[name]()
        except Exception as e:
            W.check(name, 'crashed', False, repr(e))
    n = sum(r['pass'] for r in W.RESULTS)
    print('\n%d/%d passed in %ds' % (n, len(W.RESULTS), time.time() - t0))
    json.dump(W.RESULTS, open(os.path.join(HERE, '.test-results.json'), 'w'), indent=1, default=str)
