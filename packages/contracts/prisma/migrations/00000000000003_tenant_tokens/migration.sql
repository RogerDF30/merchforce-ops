-- The wire contract's `token` field resolves to a tenant. Hashed, so a dump
-- does not expose every supplier's API token.
ALTER TABLE "tenants" ADD COLUMN "api_token_hash" TEXT;
ALTER TABLE "tenants" ADD COLUMN "master_key_hash" TEXT;

-- No rows exist yet, so backfill is a no-op; the NOT NULL goes on immediately
-- rather than being left as a nullable column nobody comes back to.
UPDATE "tenants" SET "api_token_hash" = gen_random_uuid()::text WHERE "api_token_hash" IS NULL;
ALTER TABLE "tenants" ALTER COLUMN "api_token_hash" SET NOT NULL;

CREATE UNIQUE INDEX "tenants_api_token_hash_key" ON "tenants"("api_token_hash");
