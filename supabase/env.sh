# Load supabase/.secrets.local into the environment without ever echoing a value.
# Usage: source supabase/env.sh
eval "$(python3 - "$(dirname "${(%):-%x}")/.secrets.local" <<'PY'
import sys, shlex
for line in open(sys.argv[1], encoding='utf-8'):
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k, v = line.split('=', 1)
    print('export %s=%s' % (k.strip(), shlex.quote(v.strip())))
PY
)"
