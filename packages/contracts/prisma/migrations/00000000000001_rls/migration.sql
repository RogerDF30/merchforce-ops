-- Row-level security: the second, independent enforcement of tenant isolation.
--
-- The application also scopes every query through a Prisma client extension,
-- but that is one codepath and codepaths get bugs. These policies sit under it
-- in the database, so a query that forgets its tenantId returns nothing rather
-- than returning someone else's rows.
--
-- Every request opens a transaction and sets app.tenant_id first
-- (see src/lib/prisma.ts). FORCE is used so the policy applies to the table
-- owner too -- without it, the role that owns the tables bypasses RLS and the
-- whole mechanism is decorative.
--
-- 'tenants' itself is deliberately NOT covered: the login path must look a
-- tenant up before any tenant context exists.

-- Returns text, not uuid: Prisma maps String ids to TEXT columns, and
-- comparing text = uuid has no operator in Postgres. The value is still
-- validated as a UUID before it is ever set (see withTenant in
-- src/lib/prisma.ts); this function's job is only to read it back.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '');
$$ LANGUAGE sql STABLE;

ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "settings"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "users"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "refresh_tokens"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "brands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brands" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "brands"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "products"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "price_tiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_tiers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "price_tiers"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "companies" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "companies"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contacts"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "account_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "account_notes"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "account_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_files" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "account_files"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "requests"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "request_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "request_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "request_lines"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shipments"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "supply_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supply_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "supply_orders"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "stock_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_logs"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "decks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "decks"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "sync_maps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_maps" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sync_maps"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "events"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
