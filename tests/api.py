"""Thin client for a Merchforce TEST backend. Never point this at production:
the suite creates enquiries, moves stock and sends notifications.

    MF_API_URL=<test /exec URL> MF_API_TOKEN=<token> MF_ADMIN_KEY=<admin pass> \
      python3 -I tests/workflow_test.py
"""
import json, os, time, urllib.request

URL = os.environ['MF_API_URL']
TOKEN = os.environ['MF_API_TOKEN']
MASTER = os.environ['MF_ADMIN_KEY']


def call(action, token=TOKEN, **body):
    body.update(action=action, token=token)
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={'Content-Type': 'text/plain'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # transient Apps Script hiccups
            if attempt == 2:
                return {'ok': False, 'error': 'transport: %s' % e}
            time.sleep(3)


def admin(action, **body):
    return call(action, adminKey=MASTER, **body)
