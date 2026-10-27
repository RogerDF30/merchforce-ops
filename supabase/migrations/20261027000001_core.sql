-- Merchforce on Supabase — core schema.
--
-- One database, many vendors. Every business row carries vendor_id, and row
-- level security lets a signed-in person read only the vendors they belong to.
-- Nobody writes tables directly: every change goes through an mf_* function
-- (later migrations), which checks membership and applies the business rules
-- (stock discipline, lifecycle) inside one transaction. The browser therefore
-- gets SELECT and EXECUTE, never INSERT/UPDATE/DELETE.

create extension if not exists pgcrypto with schema extensions;

/* ------------------------------------------------------------ tenancy */

create table public.vendors (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- CompanyStore people who can see and set up every vendor.
create table public.platform_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table public.vendor_members (
  vendor_id   uuid not null references public.vendors (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null default 'staff' check (role in ('admin', 'staff')),
  name        text not null default '',
  email       text not null default '',
  active      boolean not null default true,
  last_login  timestamptz,
  created_at  timestamptz not null default now(),
  primary key (vendor_id, user_id)
);
create index on public.vendor_members (user_id);

-- Everything the vendor configures (branding, company identity on documents,
-- PI numbering, deck design, mail mode, sync schedule). Defaults live in
-- mf_default_settings() so a new key never needs a data migration.
create table public.vendor_settings (
  vendor_id   uuid primary key references public.vendors (id) on delete cascade,
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Secrets the browser must never read (relay secret, sheet push keys).
create table public.vendor_secrets (
  vendor_id      uuid primary key references public.vendors (id) on delete cascade,
  relay_secret   text not null default '',
  sync_push_keys jsonb not null default '{}'::jsonb
);

-- Per-vendor running numbers: MF-2026-0001, PI-2026-0001, RMA-0001 …
create table public.counters (
  vendor_id   uuid not null references public.vendors (id) on delete cascade,
  name        text not null,
  year        int  not null default 0,
  value       int  not null default 0,
  primary key (vendor_id, name, year)
);

/* ------------------------------------------------------------ catalogue */

create table public.brands (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  code         text not null,
  name         text not null,
  logo_url     text not null default '',
  description  text not null default '',
  active       boolean not null default true,
  sort         int not null default 0,
  unique (vendor_id, code)
);

create table public.products (
  id             uuid primary key default gen_random_uuid(),
  vendor_id      uuid not null references public.vendors (id) on delete cascade,
  sku            text not null,
  name           text not null,
  brand_id       uuid references public.brands (id) on delete set null,
  category       text not null default '',
  subcategory    text not null default '',
  description    text not null default '',
  specs          text[] not null default '{}',
  images         text[] not null default '{}',
  moq            int not null default 1 check (moq >= 1),
  gst_rate       numeric(5,2) not null default 18,
  hsn            text not null default '',          -- a code, never a number: 0902 stays 0902
  mrp            numeric(12,2),
  lead_time      text not null default '',
  on_hand        int not null default 0,
  reserved       int not null default 0 check (reserved >= 0),
  safety_stock   int not null default 0,
  reorder_point  int not null default 0,
  visible        boolean not null default true,
  show_price     boolean not null default true,
  supply_mode    text not null default 'buy' check (supply_mode in ('make', 'buy')),
  supplier       text not null default '',          -- who this vendor buys it from ('vendor' in the old sheet)
  supplier_moq   int,
  batch_qty      int,
  sync_seen      int,                               -- on_hand last read from the vendor's own sheet
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index products_vendor_sku on public.products (vendor_id, upper(sku));

create table public.price_tiers (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors (id) on delete cascade,
  product_id  uuid not null references public.products (id) on delete cascade,
  min_qty     int not null check (min_qty >= 1),
  unit_price  numeric(12,2) not null check (unit_price >= 0),
  gst         numeric(5,2),
  unique (product_id, min_qty)
);

/* ------------------------------------------------------------ accounts */

create table public.companies (
  id               uuid primary key default gen_random_uuid(),
  vendor_id        uuid not null references public.vendors (id) on delete cascade,
  code             text not null,
  name             text not null,
  gstin            text not null default '',
  phone            text not null default '',
  email            text not null default '',
  billing_address  text not null default '',
  ship_address     text not null default '',
  state_code       text not null default '',
  owner_user_id    uuid references auth.users (id) on delete set null,
  owner_name       text not null default '',
  notes            text not null default '',
  active           boolean not null default true,
  bill_line1 text not null default '', bill_line2 text not null default '', bill_city text not null default '',
  bill_state text not null default '', bill_pin text not null default '', bill_country text not null default '',
  ship_same  boolean not null default true,
  ship_line1 text not null default '', ship_line2 text not null default '', ship_city text not null default '',
  ship_state text not null default '', ship_pin text not null default '', ship_country text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (vendor_id, code)
);

create table public.contacts (
  id              uuid primary key default gen_random_uuid(),
  vendor_id       uuid not null references public.vendors (id) on delete cascade,
  code            text not null,
  company_id      uuid not null references public.companies (id) on delete cascade,
  name            text not null default '',
  email           text not null default '',
  phone           text not null default '',
  role            text not null default '',
  consent         boolean not null default false,
  consent_ts      timestamptz,
  consent_source  text not null default '',
  unsubscribed    boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (vendor_id, code)
);

create table public.account_notes (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors (id) on delete cascade,
  company_id  uuid not null references public.companies (id) on delete cascade,
  author      text not null default '',
  text        text not null,
  created_at  timestamptz not null default now()
);

create table public.account_files (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  company_id   uuid not null references public.companies (id) on delete cascade,
  name         text not null,
  path         text not null,                    -- storage object path: <vendor_id>/accounts/<company_id>/<file>
  mime         text not null default '',
  size         int not null default 0,
  uploaded_by  text not null default '',
  created_at   timestamptz not null default now()
);

/* ------------------------------------------------------------ enquiries & orders */

create table public.requests (
  id               uuid primary key default gen_random_uuid(),
  vendor_id        uuid not null references public.vendors (id) on delete cascade,
  number           text not null,                -- MF-2026-0001, per vendor
  status           text not null default 'New' check (status in (
                     'New', 'Accepted', 'PI Sent', 'PI Accepted', 'PO Received', 'In Production',
                     'Dispatched', 'Delivered', 'Closed', 'Rejected', 'Declined', 'Expired', 'Cancelled')),
  stock_state      text not null default '' check (stock_state in ('', 'reserved', 'deducted')),
  status_dates     jsonb not null default '{}'::jsonb,
  company          text not null,
  contact          text not null,
  email            text not null,
  phone            text not null default '',
  gstin            text not null default '',
  notes            text not null default '',
  admin_notes      text not null default '',
  total_est        numeric(14,2) not null default 0,
  token            text not null unique,         -- the customer's private order link
  pi_number        text not null default '',
  pi_path          text not null default '',
  pi_total         numeric(14,2),
  pi_valid_till    text not null default '',
  po_number        text not null default '',
  po_path          text not null default '',
  ship_address     text not null default '',
  place_of_supply  text not null default '',
  company_id       uuid references public.companies (id) on delete set null,
  raised_by        text not null default '',
  assigned_to      uuid references auth.users (id) on delete set null,
  assigned_name    text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (vendor_id, number)
);
create index on public.requests (vendor_id, status);
create index on public.requests (company_id);

create table public.request_lines (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors (id) on delete cascade,
  request_id  uuid not null references public.requests (id) on delete cascade,
  line        int not null,
  sku         text not null,
  name        text not null default '',
  qty         int not null check (qty > 0),
  unit_price  numeric(12,2) not null default 0,
  line_total  numeric(14,2) not null default 0,
  list_price  numeric(12,2),
  gst         numeric(5,2) not null default 0,
  hsn         text not null default ''
);
create index on public.request_lines (request_id);

create table public.shipments (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     uuid not null references public.vendors (id) on delete cascade,
  request_id    uuid not null references public.requests (id) on delete cascade,
  shipment_no   int not null,
  ship_date     date not null default current_date,
  carrier       text not null default '',
  tracking      text not null default '',
  qty           int not null default 0,
  note          text not null default '',
  status        text not null default 'Dispatched' check (status in ('Dispatched', 'Delivered')),
  delivered_on  date,
  created_at    timestamptz not null default now(),
  unique (request_id, shipment_no)
);

/* ------------------------------------------------------------ returns */

create table public.returns (
  id              uuid primary key default gen_random_uuid(),
  vendor_id       uuid not null references public.vendors (id) on delete cascade,
  number          text not null,                -- RMA-0001
  request_id      uuid not null references public.requests (id) on delete cascade,
  company         text not null default '',
  status          text not null default 'Requested' check (status in ('Requested', 'Approved', 'Received', 'Closed', 'Rejected')),
  reason          text not null,
  note            text not null default '',
  carrier         text not null default '',
  tracking        text not null default '',
  resolution      text not null default '' check (resolution in ('', 'Credit note', 'Refund', 'Replacement', 'None')),
  amount          numeric(14,2),
  ref             text not null default '',
  doc_path        text not null default '',
  replacement_id  uuid references public.requests (id) on delete set null,
  status_dates    jsonb not null default '{}'::jsonb,
  created_by      text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (vendor_id, number)
);

create table public.return_lines (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors (id) on delete cascade,
  return_id   uuid not null references public.returns (id) on delete cascade,
  line        int not null,
  sku         text not null,
  name        text not null default '',
  qty         int not null check (qty > 0),
  restocked   int not null default 0,
  scrapped    int not null default 0
);

/* ------------------------------------------------------------ supply, decks, logs, sync */

create table public.supply_orders (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     uuid not null references public.vendors (id) on delete cascade,
  number        text not null,                  -- SO-0001
  kind          text not null check (kind in ('make', 'buy')),
  product_id    uuid references public.products (id) on delete set null,
  sku           text not null,
  name          text not null default '',
  qty           int not null check (qty > 0),
  supplier      text not null default '',
  status        text not null default 'Planned' check (status in ('Planned', 'Open', 'Done', 'Cancelled')),
  expected      date,
  ref           text not null default '',
  note          text not null default '',
  created_by    text not null default '',
  received_qty  int not null default 0,
  received_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (vendor_id, number)
);

create table public.decks (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors (id) on delete cascade,
  number      text not null,                    -- DK-0001
  name        text not null,
  skus        text[] not null default '{}',
  company_id  uuid references public.companies (id) on delete set null,
  company     text not null default '',
  pdf_path    text not null default '',
  pptx_path   text not null default '',
  created_by  text not null default '',
  sent_to     text not null default '',
  last_sent   timestamptz,
  created_at  timestamptz not null default now(),
  unique (vendor_id, number)
);

-- Every stock movement, append-only. Consumption is measured from here.
create table public.stock_log (
  id         bigserial primary key,
  vendor_id  uuid not null references public.vendors (id) on delete cascade,
  ts         timestamptz not null default now(),
  sku        text not null,
  delta      int not null,
  reason     text not null,
  actor      text not null default ''
);
create index on public.stock_log (vendor_id, ts);

create table public.audit_log (
  id         bigserial primary key,
  vendor_id  uuid references public.vendors (id) on delete cascade,   -- null = platform event
  ts         timestamptz not null default now(),
  actor      text not null default '',
  action     text not null,
  ref        text not null default '',
  detail     text not null default ''
);
create index on public.audit_log (vendor_id, ts);

-- One row per link between this vendor and a Google Sheet (pull or push).
create table public.sync_maps (
  id               uuid primary key default gen_random_uuid(),
  vendor_id        uuid not null references public.vendors (id) on delete cascade,
  position         int not null default 0,
  config           jsonb not null,
  last             jsonb,
  write_back_last  jsonb
);

/* ------------------------------------------------------------ access helpers */

-- Internals live in 'private', which the API never exposes. Policies can still
-- call these, so signed-in users get USAGE and EXECUTE, but no endpoint exists.
create schema private;
grant usage on schema private to authenticated;

create function private.mf_is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create function private.mf_is_member(v uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.vendor_members m
                 where m.vendor_id = v and m.user_id = auth.uid() and m.active)
         or private.mf_is_platform_admin();
$$;

create function private.mf_is_vendor_admin(v uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.vendor_members m
                 where m.vendor_id = v and m.user_id = auth.uid() and m.active and m.role = 'admin')
         or private.mf_is_platform_admin();
$$;

/* ------------------------------------------------------------ row level security */

do $$
declare t text;
begin
  -- Tenant tables: members read their vendor's rows; nobody writes from the browser.
  foreach t in array array['brands', 'products', 'price_tiers', 'companies', 'contacts', 'account_notes',
                           'account_files', 'requests', 'request_lines', 'shipments', 'returns', 'return_lines',
                           'supply_orders', 'decks', 'stock_log', 'audit_log', 'sync_maps', 'vendor_settings',
                           'vendor_members', 'counters']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy member_read on public.%I for select to authenticated using (private.mf_is_member(vendor_id))', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

alter table public.vendors enable row level security;
create policy member_read on public.vendors for select to authenticated using (private.mf_is_member(id));
grant select on public.vendors to authenticated;

alter table public.platform_admins enable row level security;
create policy self_read on public.platform_admins for select to authenticated using (user_id = auth.uid());
grant select on public.platform_admins to authenticated;

-- Secrets: RLS on with no policy, and no grant. Only security-definer functions read them.
alter table public.vendor_secrets enable row level security;

revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on all tables in schema public from authenticated;

-- Later migrations inherit the same stance: new tables are never writable from
-- the browser, and new functions are not callable until granted on purpose.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke insert, update, delete, truncate on tables from authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;

alter default privileges in schema private revoke execute on functions from public;

revoke execute on all functions in schema public, private from public, anon;
grant execute on function private.mf_is_platform_admin(), private.mf_is_member(uuid), private.mf_is_vendor_admin(uuid) to authenticated;
