# Deploying Merchforce

Neon (Postgres) · Cloudflare R2 (objects) · Upstash (Redis) · Fly.io (API) ·
Resend (mail) · GitHub Pages (console).

Everything below has been exercised locally against the real image except the
three provider sign-ups, which need your accounts.

---

## 1. Postgres — Neon

Create a project in **ap-southeast-1** or **ap-south-1**; every request is a
database round trip, so it wants to be near Mumbai where the API runs.

Two roles, deliberately — row-level security is bypassed by superusers and by
the table owner, so the API must connect as neither:

```sql
-- as the Neon owner role
CREATE ROLE merchforce_app LOGIN PASSWORD '<generate a long one>';
ALTER ROLE merchforce_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
```

Grants are applied by migration `00000000000002_app_role`, which also creates
the role if it is missing — so you can skip the SQL above and just set a real
password afterwards:

```sql
ALTER ROLE merchforce_app PASSWORD '<generate a long one>';
```

Keep both connection strings. `MIGRATE_DATABASE_URL` is the owner and runs DDL;
`DATABASE_URL` is `merchforce_app` and serves traffic.

> Skipping this is the failure that looks like success: with one superuser role
> the policies are present, every isolation test passes on paper, and every
> supplier sees every other supplier's orders.

## 2. Objects — Cloudflare R2

Create a bucket (`merchforce`), then an **R2 API token** with Object Read &
Write. The endpoint is `https://<account-id>.r2.cloudflarestorage.com` and the
region is `auto`.

Public product images: attach a custom domain or enable the r2.dev subdomain,
then restrict anonymous read to the `public/` prefix only. That prefix split is
the whole reason keys are shaped `public/t/<id>/...` and `private/t/<id>/...` —
granting the bucket root would expose every customer's KYC documents, which is
exactly the bug this layout was introduced to fix.

`S3_PUBLIC_BASE` is that public base plus the bucket path, with no trailing
slash.

## 3. Redis — Upstash

Any Redis works; it is used for login rate limiting only. Take the `rediss://`
URL. If Redis is unreachable the API still serves — rate limiting degrades, it
does not block.

## 4. Mail — Resend

One Resend account for the platform. Each supplier verifies **their own** domain
in it and sets `mail_from_email` in Settings; until they do, their mail goes out
on `MAIL_FALLBACK_FROM` carrying their name, with reply-to pointing at them.

Verify the fallback domain too, or nothing sends at all.

## 5. API — Fly.io

```bash
fly launch --no-deploy --name merchforce-api --region bom
fly secrets set \
  DATABASE_URL="postgresql://merchforce_app:...@...neon.tech/merchforce?sslmode=require" \
  MIGRATE_DATABASE_URL="postgresql://owner:...@...neon.tech/merchforce?sslmode=require" \
  REDIS_URL="rediss://...upstash.io:6379" \
  S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  S3_BUCKET="merchforce" \
  S3_ACCESS_KEY_ID="..." \
  S3_SECRET_ACCESS_KEY="..." \
  S3_PUBLIC_BASE="https://cdn.yourdomain.com/merchforce" \
  JWT_SECRET="$(openssl rand -hex 32)" \
  RESEND_API_KEY="re_..." \
  MAIL_FALLBACK_FROM="no-reply@yourdomain.com" \
  PUBLIC_ORDER_URL="https://rogerdf30.github.io/merchforce-ops/order.html" \
  CORS_ORIGINS="https://rogerdf30.github.io"
fly deploy
```

`fly deploy` builds on Fly's x86_64 builders. The Prisma engine target for that
is declared in the schema rather than detected, because detection happens at
build time and would otherwise pick up the architecture of whatever machine ran
the build.

Migrations run as the release command, before any new machine takes traffic.

Check it: `curl https://merchforce-api.fly.dev/health` → `{"ok":true,"db":"up"}`.

## 6. Provision a tenant

Provisioning runs from your machine against the production database, not from
inside the container — the scripts are TypeScript and the image ships only
compiled output.

```bash
export DATABASE_URL="postgresql://merchforce_app:...@...neon.tech/merchforce?sslmode=require"
export MIGRATE_DATABASE_URL="postgresql://owner:...@...neon.tech/merchforce?sslmode=require"

pnpm --filter @merchforce/api exec tsx prisma/seed.ts \
  --slug acme --name "Acme Merch" --admin you@acme.com
```

It prints the API token, master key and admin password once. They are stored
hashed; a lost token is reprovisioned, never recovered.

Migrating an existing Apps Script install instead — see `ARCHITECTURE.md`:

```bash
pnpm --filter @merchforce/api exec tsx scripts/migrate.ts \
  --from ./export --slug acme --name "Acme Merch" --dry-run
```

Set `LEGACY_PEPPER` to the PEPPER from that install's Script Properties, or the
migrated staff cannot sign in. Remove it once no row has `password_legacy` set:

```sql
SELECT count(*) FROM users WHERE password_legacy;
```

## 7. Console — GitHub Pages

Merge `console-cutover` into `main`. Pages republishes and the console is on the
new API.

There is no credential to set. The console names its supplier with a **public
slug** and authorises nothing with it:

```js
TENANT: fromQuery || window.MF_TENANT || fromHost || ''
```

so `?tenant=acme`, or `acme.merchforce.app`, or a one-line `MF_TENANT` in an
untracked `assets/js/config.js`. One build serves every supplier.

That is deliberate rather than lax. A token that ships in a JavaScript bundle
is readable by anyone who opens the file — this repository shipped a real one
for a week (see `ROTATE.md`). Every admin action needs a staff session,
signing in is bcrypt behind a per-IP and per-account rate limit, and a
customer's order page is authorised by that order's own token. The slug decides
*which* supplier is being asked about, nothing more.

`window.MF_API_URL` overrides the API origin the same way, for a staging deploy.

## 8. After cutover

- Rotate the old Apps Script `API_TOKEN` and `SETUP_KEY` — both are in this
  repo's git history and still reach the old backend until they are changed.
- Leave the Sheet read-only for a while. Nothing reads it, but it is the only
  copy of anything the migration reported as dropped.
- Watch `audit_logs` for `mail_fail` in the first days; an unverified sending
  domain shows up there and nowhere else.

## Rolling back

`fly releases` then `fly deploy --image <previous>`. Migrations are additive and
no deploy so far drops a column, so an older image runs against a newer schema.
That stops being true the first time a migration removes something — at which
point a rollback needs a matching down-migration written by hand.
