# Merchforce — architecture

Re-platform of the Google Apps Script / Sheets / Drive backend onto Postgres,
S3-compatible object storage and a Node API, with multiple supplier businesses
on one deployment.

## The move

| Was | Is |
|---|---|
| Google Sheet tabs | Postgres (Neon in production) |
| Drive folders | Cloudflare R2 via the S3 API (MinIO locally) |
| Apps Script `/exec` | Node 20 + TypeScript + Express |
| `makeStaffSession_` blob | JWT access token + rotating refresh token |
| SHA-256(pass+salt+pepper) | bcrypt, cost 12 |
| `sync_maps` JSON in Settings | `sync_maps` table, push keys hashed |
| Single supplier | `Tenant` on every row |

## Why the wire contract did not change

Every backend call in the frontend goes through one `api()` helper
(`assets/js/admin.js:42`) posting `{token, action, ...}` to a single URL. The
new API speaks that same contract, action for action. So the ~3,700-line admin
console keeps working against the new backend with a URL change, and the
frontend rewrite becomes a separate decision taken later, against a contract
that is already stable rather than one still in motion.

## Tenant isolation

A `Tenant` is a **supplier business**. Every table except `tenants` carries
`tenant_id`, and isolation is enforced twice, independently:

1. **Application** — `withTenant()` (`src/lib/prisma.ts`) opens a transaction
   and sets `app.tenant_id`. Nothing tenant-scoped runs outside it.
2. **Database** — row-level security policies on all 19 tenant-scoped tables
   read that setting. A query that forgets its tenant returns nothing rather
   than someone else's rows.

`SET LOCAL` is used, not `SET`: the setting dies with the transaction, so a
pooled connection cannot carry one supplier's context into the next request.
The tenant id is regex-checked as a UUID before interpolation, because
`SET LOCAL` cannot be parameterised.

### Two database roles, deliberately

RLS is bypassed unconditionally by superusers, and by the table owner unless
`FORCE ROW LEVEL SECURITY` is set. Setting FORCE alone is not enough — an
application connecting as the superuser still sees every tenant. So:

- `merchforce` — owner. Runs migrations (`MIGRATE_DATABASE_URL`, wired through
  Prisma's `directUrl`). Never serves traffic.
- `merchforce_app` — `NOSUPERUSER NOBYPASSRLS`, DML only, no DDL. What the API
  connects as (`DATABASE_URL`). Cannot drop the policies that constrain it.

This was caught by testing against real Postgres: with a single superuser role,
all four isolation probes failed silently and the policies were decorative.

Verified behaviour, as `merchforce_app`:

| Probe | Result |
|---|---|
| Read own tenant | own rows only |
| Read another tenant explicitly | 0 rows |
| Read with no tenant context | 0 rows |
| Write a row tagged another tenant | refused by policy |
| `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` | refused, not owner |

## Object storage

Keys are `t/<tenantId>/<kind>/<uuid><ext>` — a tenant's objects are one prefix
to export, audit or delete. Objects are private; reads go out as presigned URLs
with a one-hour life, replacing Drive's permanent shared links. Uploads that are
not image or PDF are stored `Content-Disposition: attachment`, so an uploaded
`.html` cannot execute on our origin. Every client-supplied key passes
`assertKeyBelongsTo()` before use.

## Security changes from the Apps Script version

- **Login throttling.** `fnStaffLogin_` had no rate limit and no lockout. With
  the API token — which was committed to a public repo — that was an unlimited
  password oracle against every staff account. Now limited per IP and per email.
- **bcrypt** replaces a single fast SHA-256. A leaked user table was previously
  brute-forceable at GPU speed. Legacy hashes verify once and are re-hashed on
  next successful sign-in (`verifyLegacy`, to be deleted once none remain).
- **JWT algorithm pinned** to HS256, so a token claiming `"alg":"none"` is
  rejected.
- **Push keys hashed.** Sheet-connector keys were stored in clear in a Settings
  JSON blob; now hashed, shown once at generation.
- **No secrets in the repo.** `API_TOKEN` and `SETUP_KEY` were both committed
  (`assets/js/*.js:8`, `apps-script/Config.gs:7`). All secrets now come from the
  environment and `.env` is ignored.

## Local development

    docker compose up -d                 # Postgres, Redis, MinIO
    pnpm install
    pnpm db:deploy                       # migrations, as the owner role
    pnpm dev                             # API on :8901

MinIO console is on :9001 (merchforce / merchforce123).

## Status

Foundation complete and verified: schema (20 models), migrations, tenant
isolation, storage layer, auth primitives, action dispatcher. The 58 action
handlers, deck generation, mail and sheet sync are the remaining work — see
the phase plan.
