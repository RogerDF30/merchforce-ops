-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('active', 'suspended', 'cancelled');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'staff');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('New', 'Accepted', 'PI Sent', 'PI Accepted', 'PO Received', 'In Production', 'Dispatched', 'Delivered', 'Closed', 'Rejected', 'Declined', 'Expired', 'Cancelled');

-- CreateEnum
CREATE TYPE "StockState" AS ENUM ('none', 'reserved', 'deducted');

-- CreateEnum
CREATE TYPE "SupplyKind" AS ENUM ('make', 'buy');

-- CreateEnum
CREATE TYPE "SupplyStatus" AS ENUM ('planned', 'ordered', 'partial', 'received', 'cancelled');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('pending', 'dispatched', 'delivered', 'cancelled');

-- CreateEnum
CREATE TYPE "SupplyMode" AS ENUM ('make', 'buy');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT,
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pass_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'staff',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_login" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_url" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand_id" TEXT,
    "category" TEXT,
    "subcategory" TEXT,
    "description" TEXT,
    "specs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "image_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "moq" INTEGER NOT NULL DEFAULT 1,
    "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "hsn" TEXT,
    "mrp" DECIMAL(12,2),
    "lead_time" INTEGER,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "safety_stock" INTEGER NOT NULL DEFAULT 0,
    "reorder_point" INTEGER NOT NULL DEFAULT 0,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "show_price" BOOLEAN NOT NULL DEFAULT true,
    "supply_mode" "SupplyMode",
    "vendor" TEXT,
    "vendor_moq" INTEGER,
    "batch_qty" INTEGER,
    "sync_seen" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_tiers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "min_qty" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "gst" DECIMAL(5,2),

    CONSTRAINT "price_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "bill_line1" TEXT,
    "bill_line2" TEXT,
    "bill_city" TEXT,
    "bill_state" TEXT,
    "bill_pin" TEXT,
    "bill_country" TEXT DEFAULT 'India',
    "ship_same" BOOLEAN NOT NULL DEFAULT true,
    "ship_line1" TEXT,
    "ship_line2" TEXT,
    "ship_city" TEXT,
    "ship_state" TEXT,
    "ship_pin" TEXT,
    "ship_country" TEXT DEFAULT 'India',
    "state_code" TEXT,
    "owner_id" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" TEXT,
    "consent" BOOLEAN NOT NULL DEFAULT false,
    "consent_ts" TIMESTAMP(3),
    "consent_source" TEXT,
    "unsubscribed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_notes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_files" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mime" TEXT,
    "size" INTEGER,
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'New',
    "stock_state" "StockState" NOT NULL DEFAULT 'none',
    "company_id" TEXT,
    "company" TEXT,
    "contact" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "gstin" TEXT,
    "notes" TEXT,
    "adminNotes" TEXT,
    "total_est" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status_dates" JSONB NOT NULL DEFAULT '{}',
    "token" TEXT NOT NULL,
    "pi_number" TEXT,
    "pi_key" TEXT,
    "pi_total" DECIMAL(14,2),
    "pi_valid_till" TIMESTAMP(3),
    "po_number" TEXT,
    "po_key" TEXT,
    "ship_address" TEXT,
    "place_of_supply" TEXT,
    "raised_by" TEXT,
    "assigned_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_lines" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "product_id" TEXT,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "list_price" DECIMAL(12,2),
    "line_total" DECIMAL(14,2) NOT NULL,
    "gst" DECIMAL(5,2),
    "hsn" TEXT,

    CONSTRAINT "request_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "shipment_no" INTEGER NOT NULL,
    "ship_date" TIMESTAMP(3),
    "carrier" TEXT,
    "tracking" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'pending',
    "delivered_on" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supply_orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" "SupplyKind" NOT NULL,
    "product_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "vendor" TEXT,
    "status" "SupplyStatus" NOT NULL DEFAULT 'planned',
    "expected" TIMESTAMP(3),
    "external_ref" TEXT,
    "note" TEXT,
    "received_qty" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supply_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actor" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "skus" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "company_id" TEXT,
    "company" TEXT,
    "pdf_key" TEXT,
    "pptx_key" TEXT,
    "created_by" TEXT,
    "sent_to" TEXT,
    "last_sent" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_maps" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "brand_id" TEXT,
    "label" TEXT,
    "sheet_id" TEXT,
    "tab" TEXT,
    "sku_col" TEXT,
    "stock_col" TEXT,
    "push_key_hash" TEXT NOT NULL,
    "tabs_meta" JSONB,
    "last_run_at" TIMESTAMP(3),
    "last_result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "product_id" TEXT,
    "sku" TEXT,
    "type" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "ref" TEXT,
    "detail" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "settings_tenant_id_key_key" ON "settings"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_tenant_id_user_id_idx" ON "refresh_tokens"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "brands_tenant_id_idx" ON "brands"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "brands_tenant_id_code_key" ON "brands"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "products_tenant_id_visible_idx" ON "products"("tenant_id", "visible");

-- CreateIndex
CREATE INDEX "products_tenant_id_brand_id_idx" ON "products"("tenant_id", "brand_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_sku_key" ON "products"("tenant_id", "sku");

-- CreateIndex
CREATE INDEX "price_tiers_tenant_id_idx" ON "price_tiers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_tiers_product_id_min_qty_key" ON "price_tiers"("product_id", "min_qty");

-- CreateIndex
CREATE INDEX "companies_tenant_id_active_idx" ON "companies"("tenant_id", "active");

-- CreateIndex
CREATE INDEX "companies_tenant_id_name_idx" ON "companies"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_company_id_idx" ON "contacts"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "account_notes_tenant_id_company_id_idx" ON "account_notes"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "account_files_tenant_id_company_id_idx" ON "account_files"("tenant_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "requests_token_key" ON "requests"("token");

-- CreateIndex
CREATE INDEX "requests_tenant_id_status_idx" ON "requests"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "requests_tenant_id_company_id_idx" ON "requests"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "requests_tenant_id_assigned_id_idx" ON "requests"("tenant_id", "assigned_id");

-- CreateIndex
CREATE UNIQUE INDEX "requests_tenant_id_ref_key" ON "requests"("tenant_id", "ref");

-- CreateIndex
CREATE INDEX "request_lines_tenant_id_idx" ON "request_lines"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "request_lines_request_id_line_key" ON "request_lines"("request_id", "line");

-- CreateIndex
CREATE INDEX "shipments_tenant_id_status_idx" ON "shipments"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_request_id_shipment_no_key" ON "shipments"("request_id", "shipment_no");

-- CreateIndex
CREATE INDEX "supply_orders_tenant_id_status_idx" ON "supply_orders"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "supply_orders_tenant_id_kind_idx" ON "supply_orders"("tenant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "supply_orders_tenant_id_ref_key" ON "supply_orders"("tenant_id", "ref");

-- CreateIndex
CREATE INDEX "stock_logs_tenant_id_product_id_created_at_idx" ON "stock_logs"("tenant_id", "product_id", "created_at");

-- CreateIndex
CREATE INDEX "decks_tenant_id_idx" ON "decks"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_maps_push_key_hash_key" ON "sync_maps"("push_key_hash");

-- CreateIndex
CREATE INDEX "sync_maps_tenant_id_idx" ON "sync_maps"("tenant_id");

-- CreateIndex
CREATE INDEX "events_tenant_id_day_idx" ON "events"("tenant_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "events_tenant_id_day_sku_type_key" ON "events"("tenant_id", "day", "sku", "type");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_action_idx" ON "audit_logs"("tenant_id", "action");

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_tiers" ADD CONSTRAINT "price_tiers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_tiers" ADD CONSTRAINT "price_tiers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_notes" ADD CONSTRAINT "account_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_notes" ADD CONSTRAINT "account_notes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_files" ADD CONSTRAINT "account_files_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_files" ADD CONSTRAINT "account_files_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requests" ADD CONSTRAINT "requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requests" ADD CONSTRAINT "requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requests" ADD CONSTRAINT "requests_assigned_id_fkey" FOREIGN KEY ("assigned_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_lines" ADD CONSTRAINT "request_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_lines" ADD CONSTRAINT "request_lines_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_lines" ADD CONSTRAINT "request_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_orders" ADD CONSTRAINT "supply_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_orders" ADD CONSTRAINT "supply_orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_logs" ADD CONSTRAINT "stock_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_logs" ADD CONSTRAINT "stock_logs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decks" ADD CONSTRAINT "decks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decks" ADD CONSTRAINT "decks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_maps" ADD CONSTRAINT "sync_maps_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_maps" ADD CONSTRAINT "sync_maps_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

