#!/bin/zsh
# Apply any migration not yet recorded on the Supabase project, each in its own
# transaction. Records versions in supabase_migrations.schema_migrations, the
# table the Supabase CLI uses, so `supabase db push` agrees later.
set -e
cd "$(dirname "$0")"
source ./db.sh
mfdb -q -c "create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);"
for f in migrations/*.sql; do
  base=$(basename "$f" .sql); ver=${base%%_*}; name=${base#*_}
  if [[ -n "$(mfdb -tA -c "select 1 from supabase_migrations.schema_migrations where version = '$ver'")" ]]; then
    echo "skip   $base"; continue
  fi
  { echo "begin;"; cat "$f"; echo; echo "insert into supabase_migrations.schema_migrations (version, name) values ('$ver', '$name');"; echo "commit;"; } \
    | mfdb -q 2>&1 | grep -v NOTICE || true
  [[ -n "$(mfdb -tA -c "select 1 from supabase_migrations.schema_migrations where version = '$ver'")" ]] \
    && echo "applied $base" || { echo "FAILED $base"; exit 1; }
done
