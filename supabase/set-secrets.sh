#!/bin/zsh
# Store the mail sender's secrets on the Supabase project. Run it yourself:
#   zsh ~/Projects/merchforce-ops/supabase/set-secrets.sh
#
# Reads supabase/.secrets.local (BREVO_API_KEY etc.), generates the scheduler
# password if missing, then sets:
#   Edge Function secrets: BREVO_API_KEY, MF_CRON_SECRET, MAIL_FROM,
#                          GOOGLE_SERVICE_ACCOUNT (from google-service-account.json, if present)
#   Vault: mf_functions_url, mf_cron_secret  (read by the pg_cron mail job)
# Prints secret names only, never values. Safe to re-run.
set -e
cd "$(dirname "$0")"
F=.secrets.local
if ! grep -q '^MF_CRON_SECRET=' $F; then
  printf '\n# Shared secret between pg_cron and the mail/sync edge functions (generated)\nMF_CRON_SECRET=%s\n' \
    "$(python3 -c 'import secrets;print(secrets.token_hex(24))')" >> $F
fi
source ./db.sh
[[ "$BREVO_API_KEY" == xkeysib-* ]] || { echo "BREVO_API_KEY missing or wrong format in $F"; exit 1; }

T=$(mktemp); chmod 600 "$T"; trap 'rm -f "$T"' EXIT
printf 'BREVO_API_KEY=%s\nMF_CRON_SECRET=%s\nMAIL_FROM=notifications@merchforce.io\n' "$BREVO_API_KEY" "$MF_CRON_SECRET" > "$T"
NAMES="BREVO_API_KEY, MF_CRON_SECRET, MAIL_FROM"
if [[ -f google-service-account.json ]]; then
  # base64 on one line, so the JSON key survives the env file intact
  printf 'GOOGLE_SERVICE_ACCOUNT=%s\n' "$(base64 -i google-service-account.json | tr -d '\n')" >> "$T"
  NAMES="$NAMES, GOOGLE_SERVICE_ACCOUNT"
fi
mfsb secrets set --env-file "$T" >/dev/null 2>&1 && echo "Function secrets set: $NAMES"

mfdb -q -v url="https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1" -v sec="$MF_CRON_SECRET" <<'SQL'
delete from vault.secrets where name in ('mf_functions_url', 'mf_cron_secret');
select vault.create_secret(:'url', 'mf_functions_url');
select vault.create_secret(:'sec', 'mf_cron_secret');
SQL
echo "Vault entries set: $(mfdb -tA -c "select string_agg(name, ', ' order by name) from vault.secrets where name like 'mf_%'")"
