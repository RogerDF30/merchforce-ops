#!/bin/zsh
# Copy the public site (and nothing else: no backend code, tests or secrets) into hosting/dist.
set -e
cd "$(dirname "$0")/.."
rm -rf hosting/dist && mkdir -p hosting/dist/assets/js hosting/dist/assets/css
cp index.html admin.html order.html platform.html hosting/dist/
cp assets/css/style.css hosting/dist/assets/css/
cp assets/js/{mf-config,mf-client,admin,order,platform}.js hosting/dist/assets/js/
cat > hosting/dist/404.html <<'HTML'
<!doctype html><meta charset="utf-8"><title>Not found</title><meta name="robots" content="noindex">
<body style="font:15px system-ui;margin:60px;color:#333"><h2>Page not found</h2><p><a href="/admin.html">Open Merchforce</a></p>
HTML
cat > hosting/dist/_headers <<'HDR'
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Robots-Tag: noindex, nofollow
HDR
# the service key must never ship
! grep -rl "service_role" hosting/dist >/dev/null || { echo "REFUSING: service_role found in dist"; exit 1; }
echo "built: $(find hosting/dist -type f | wc -l | tr -d ' ') files"
