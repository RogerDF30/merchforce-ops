# psql against the Supabase project (session pooler), password from .env.local, never echoed.
# Usage: source supabase/db.sh; mfdb -c "select 1"
source "$(dirname "${(%):-%x}")/env.sh"
mfdb() {
  PGPASSWORD="$SUPABASE_DB_PASSWORD" PGSSLMODE=require /opt/homebrew/opt/postgresql@16/bin/psql \
    -h aws-0-ap-south-1.pooler.supabase.com -p 5432 -U "postgres.$SUPABASE_PROJECT_REF" -d postgres \
    -v ON_ERROR_STOP=1 "$@"
}

# Supabase CLI, pinned (installed via npm: Homebrew needs newer Command Line Tools on this Mac).
mfsb() { npx --yes supabase@2.122.0 "$@"; }
