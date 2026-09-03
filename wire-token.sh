#!/bin/zsh
# Usage: ./wire-token.sh mf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Writes the API token into the frontend, commits, pushes.
set -e
cd "$(dirname "$0")"
[ -n "$1" ] || { echo "Pass the API_TOKEN from Script Properties as the first argument."; exit 1; }
python3 - "$1" <<'PY'
import sys, pathlib, re
tok = sys.argv[1].strip()
if not tok.startswith('mf_'):
    print('That does not look like an API_TOKEN (expected mf_...)'); sys.exit(1)
n = 0
for f in ('assets/js/admin.js', 'assets/js/order.js'):
    p = pathlib.Path(f); t = p.read_text()
    t2 = re.sub(r"(\? 'mf-demo-token' : )''", lambda m: m.group(1) + "'" + tok + "'", t)
    if t2 != t: n += 1
    p.write_text(t2)
print('wired into', n, 'files')
PY
git add -A
git commit -q -m "Wire the frontend to the provisioned backend"
git push -q origin main
echo "pushed — https://rogerdf30.github.io/merchforce-ops/admin.html"
