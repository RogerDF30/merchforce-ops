"""Stand-in for tests/api.py that points the shared workflow suite at Supabase.

workflow_test.py calls admin(action, ...) as the vendor's admin and
call(action, session=..., ...) as a signed-in person or a signed-out customer.
There is no master key on Supabase: admin() is the test vendor's admin login.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sb_api as sb

USERS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.test-users.local')))
SLUG = 'mftest'
TOKEN = None
_jwt = {}


def jwt(who):
    if who not in _jwt:
        _jwt[who] = sb.sign_in(USERS[who]['email'], USERS[who]['password'])
    return _jwt[who]


def admin(action, **body):
    body['vendor'] = SLUG
    return sb.rpc(action, body, jwt('owner'))


def call(action, token=None, session=None, adminKey=None, **body):
    if action == 'staffLogin':
        t = sb.sign_in(body.get('email', ''), body.get('password', ''))
        return {'ok': True, 'session': t} if t else {'ok': False, 'error': 'Invalid email or password'}
    body['vendor'] = SLUG
    return sb.rpc(action, body, session)
