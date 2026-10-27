#!/bin/zsh
# Rebuild a throwaway local database from the migrations and run every SQL test.
# Usage: supabase/tests/run_local.sh   (needs the local server from the setup notes on port 54329)
set -e
cd "$(dirname "$0")/.."
PG=/opt/homebrew/opt/postgresql@16/bin
psql_() { $PG/psql -h /tmp -p 54329 -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
$PG/dropdb -h /tmp -p 54329 -U postgres --if-exists mf_test
$PG/createdb -h /tmp -p 54329 -U postgres mf_test
psql_ -d mf_test -f tests/auth_stub.sql
for m in migrations/*.sql; do
  if ! out=$(psql_ -d mf_test -f "$m" 2>&1); then echo "MIGRATION FAILED $m"; echo "$out" | grep -E "ERROR|LINE" | head -5; exit 1; fi
done
fail=0
for t in tests/*.sql; do
  case "$t" in *auth_stub*) continue;; esac
  out=$(psql_ -d mf_test -tA -f "$t" 2>&1) || true
  if echo "$out" | grep -q '^PASS'; then echo "$(echo "$out" | grep '^PASS')"; else echo "FAIL $t"; echo "$out" | grep -E 'ERROR|exception' | head -3; fail=1; fi
done
exit $fail
