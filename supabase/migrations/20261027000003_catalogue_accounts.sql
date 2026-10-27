-- Merchforce on Supabase — catalogue (brands, products, price tiers) and
-- accounts (companies, contacts, notes). Same actions and response shapes as
-- the Apps Script backend (Admin.gs, Companies.gs, Accounts.gs).
--
-- API identifiers stay human: a brand is its code (BR-…), a company its code
-- (CO-0001), a contact CT-0001, a product its SKU. UUIDs never leave the database.

-- The console treats specs as one '|'-separated string.
alter table public.products alter column specs drop default;
alter table public.products alter column specs type text using array_to_string(specs, '|');
alter table public.products alter column specs set default '';

/* ------------------------------------------------------------ outbox */

-- Side effects (email, writing stock back to a vendor's sheet) are queued in
-- the same transaction as the change that causes them; an edge function sends
-- them. A rolled-back change therefore never emails anyone.
create table private.outbox (
  id          bigserial primary key,
  vendor_id   uuid references public.vendors (id) on delete cascade,
  kind        text not null check (kind in ('mail', 'writeback')),
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  attempts    int not null default 0,
  sent_at     timestamptz,
  error       text not null default ''
);
create index on private.outbox (sent_at) where sent_at is null;

create function private.mf_enqueue(v uuid, kind text, payload jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into private.outbox (vendor_id, kind, payload) values (v, kind, payload);
$$;

-- Email: {to, subject, body, reply_to}. Skipped quietly when there is no address.
create function private.mf_mail(v uuid, mail_to text, subject text, body text, reply_to text default '') returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(trim(mail_to), '') = '' then return; end if;
  perform private.mf_enqueue(v, 'mail', jsonb_build_object('to', trim(mail_to), 'subject', subject, 'body', body, 'reply_to', coalesce(reply_to, '')));
end $$;

/* ------------------------------------------------------------ shared lookups */

create table private.gst_states (code text primary key, name text not null);
insert into private.gst_states (code, name) values
  ('01','Jammu & Kashmir'),('02','Himachal Pradesh'),('03','Punjab'),('04','Chandigarh'),('05','Uttarakhand'),
  ('06','Haryana'),('07','Delhi'),('08','Rajasthan'),('09','Uttar Pradesh'),('10','Bihar'),('11','Sikkim'),
  ('12','Arunachal Pradesh'),('13','Nagaland'),('14','Manipur'),('15','Mizoram'),('16','Tripura'),('17','Meghalaya'),
  ('18','Assam'),('19','West Bengal'),('20','Jharkhand'),('21','Odisha'),('22','Chhattisgarh'),('23','Madhya Pradesh'),
  ('24','Gujarat'),('26','Dadra & Nagar Haveli and Daman & Diu'),('27','Maharashtra'),('29','Karnataka'),('30','Goa'),
  ('31','Lakshadweep'),('32','Kerala'),('33','Tamil Nadu'),('34','Puducherry'),('35','Andaman & Nicobar Islands'),
  ('36','Telangana'),('37','Andhra Pradesh'),('38','Ladakh'),('97','Other Territory');

create function private.mf_num(j jsonb, k text, dflt numeric default 0) returns numeric
language sql immutable set search_path = '' as $$
  select case when j->>k ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (j->>k)::numeric else dflt end;
$$;

create function private.mf_bool(j jsonb, k text, dflt boolean default false) returns boolean
language sql immutable set search_path = '' as $$
  select case when j ? k and jsonb_typeof(j->k) = 'boolean' then (j->k)::boolean
              when upper(j->>k) in ('TRUE', '1', 'YES') then true
              when upper(j->>k) in ('FALSE', '0', 'NO', '') then false
              else dflt end;
$$;

create function private.mf_valid_email(e text) returns boolean
language sql immutable set search_path = '' as $$ select coalesce(e, '') ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'; $$;

create function private.mf_atp(on_hand int, reserved int, safety_stock int) returns int
language sql immutable set search_path = '' as $$ select on_hand - reserved - safety_stock; $$;

/* ------------------------------------------------------------ catalogue */

create function private.mf_product_out(pr public.products) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sku', pr.sku, 'name', pr.name,
    'brand_id', coalesce((select b.code from public.brands b where b.id = pr.brand_id), ''),
    'category', pr.category, 'subcategory', pr.subcategory, 'description', pr.description, 'specs', pr.specs,
    'images', to_jsonb(pr.images), 'moq', pr.moq, 'gst_rate', pr.gst_rate, 'lead_time', pr.lead_time,
    'mrp', coalesce(to_jsonb(pr.mrp), '""'::jsonb), 'hsn', pr.hsn,
    'on_hand', pr.on_hand, 'reserved', pr.reserved, 'safety_stock', pr.safety_stock, 'reorder_point', pr.reorder_point,
    'atp', private.mf_atp(pr.on_hand, pr.reserved, pr.safety_stock),
    'visible', pr.visible, 'show_price', pr.show_price,
    'tiers', coalesce((select jsonb_agg(jsonb_build_object('min', t.min_qty, 'price', t.unit_price,
                                                           'gst', coalesce(to_jsonb(t.gst), '""'::jsonb)) order by t.min_qty)
                       from public.price_tiers t where t.product_id = pr.id), '[]'::jsonb));
$$;

create function public.mf_admin_catalog(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  return jsonb_build_object('ok', true,
    'products', coalesce((select jsonb_agg(private.mf_product_out(pr) order by pr.created_at, pr.sku)
                          from public.products pr where pr.vendor_id = c.vendor_id), '[]'::jsonb),
    'brands', coalesce((select jsonb_agg(jsonb_build_object('id', b.code, 'name', b.name, 'logo', b.logo_url,
                          'desc', b.description, 'active', b.active, 'sort', b.sort) order by b.sort, b.name)
                        from public.brands b where b.vendor_id = c.vendor_id), '[]'::jsonb));
end $$;

-- Create or update a product and replace its price tiers. The first tier must
-- start at the MOQ. Reservations are lifecycle-owned and never set here; a
-- change to on hand is logged as a manual adjustment and written back to the sheet.
create function public.mf_admin_product_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  d jsonb := coalesce(p->'product', '{}'::jsonb);
  v_sku text := upper(trim(coalesce(d->>'sku', '')));
  v_moq int := greatest(1, coalesce(nullif(private.mf_num(d, 'moq'), 0), 1)::int);
  v_brand uuid;
  v_first numeric;
  old public.products;
  v_id uuid;
  v_on_hand int := private.mf_num(d, 'on_hand')::int;
begin
  if v_sku = '' or coalesce(trim(d->>'name'), '') = '' then raise exception 'SKU and name are required'; end if;
  select min(private.mf_num(t, 'min')) into v_first from jsonb_array_elements(coalesce(d->'tiers', '[]'::jsonb)) t;
  if v_first is not null and v_first <> v_moq then
    raise exception 'The first price tier must start at the MOQ (%)', v_moq;
  end if;
  if coalesce(d->>'brand_id', '') <> '' then
    select b.id into v_brand from public.brands b where b.vendor_id = c.vendor_id and b.code = d->>'brand_id';
    if v_brand is null then raise exception 'Unknown brand: %', d->>'brand_id'; end if;
  end if;

  select * into old from public.products pr where pr.vendor_id = c.vendor_id and upper(pr.sku) = v_sku for update;
  if old.id is null then
    insert into public.products (vendor_id, sku, name, brand_id, category, subcategory, description, specs, images,
                                 moq, gst_rate, lead_time, mrp, hsn, on_hand, reserved, safety_stock, reorder_point,
                                 visible, show_price)
    values (c.vendor_id, v_sku, trim(d->>'name'), v_brand, coalesce(d->>'category', ''), coalesce(d->>'subcategory', ''),
            coalesce(d->>'description', ''), coalesce(d->>'specs', ''),
            coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(d->'images', '[]'::jsonb)) x), '{}'),
            v_moq, private.mf_num(d, 'gst_rate'), coalesce(d->>'lead_time', ''), nullif(private.mf_num(d, 'mrp'), 0),
            trim(coalesce(d->>'hsn', '')), v_on_hand, 0,
            private.mf_num(d, 'safety_stock')::int, private.mf_num(d, 'reorder_point')::int,
            private.mf_bool(d, 'visible'), private.mf_bool(d, 'show_price'))
    returning id into v_id;
  else
    v_id := old.id;
    update public.products set
      name = trim(d->>'name'), brand_id = v_brand, category = coalesce(d->>'category', ''),
      subcategory = coalesce(d->>'subcategory', ''), description = coalesce(d->>'description', ''),
      specs = coalesce(d->>'specs', ''),
      images = coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(d->'images', '[]'::jsonb)) x), '{}'),
      moq = v_moq, gst_rate = private.mf_num(d, 'gst_rate'), lead_time = coalesce(d->>'lead_time', ''),
      mrp = nullif(private.mf_num(d, 'mrp'), 0), hsn = trim(coalesce(d->>'hsn', '')),
      on_hand = v_on_hand, safety_stock = private.mf_num(d, 'safety_stock')::int,
      reorder_point = private.mf_num(d, 'reorder_point')::int,
      visible = private.mf_bool(d, 'visible'), show_price = private.mf_bool(d, 'show_price'),
      updated_at = now()
    where id = v_id;
    if old.on_hand <> v_on_hand then
      insert into public.stock_log (vendor_id, sku, delta, reason, actor)
      values (c.vendor_id, old.sku, v_on_hand - old.on_hand, 'manual adjust', c.actor);
      perform private.mf_enqueue(c.vendor_id, 'writeback', jsonb_build_object('skus', jsonb_build_array(old.sku)));
    end if;
  end if;

  delete from public.price_tiers where product_id = v_id;
  insert into public.price_tiers (vendor_id, product_id, min_qty, unit_price, gst)
  select c.vendor_id, v_id, private.mf_num(t, 'min')::int, private.mf_num(t, 'price'),
         case when coalesce(t->>'gst', '') = '' then null else private.mf_num(t, 'gst') end
    from jsonb_array_elements(coalesce(d->'tiers', '[]'::jsonb)) t;

  perform private.mf_audit(c.vendor_id, c.actor, 'product_save', v_sku);
  return jsonb_build_object('ok', true, 'sku', v_sku);
end $$;

-- Soft delete: hidden, kept, because orders reference the SKU.
create function public.mf_admin_product_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  update public.products set visible = false, updated_at = now()
   where vendor_id = c.vendor_id and upper(sku) = upper(coalesce(p->>'sku', ''));
  if not found then raise exception 'Not found'; end if;
  perform private.mf_audit(c.vendor_id, c.actor, 'product_hide', p->>'sku');
  return jsonb_build_object('ok', true);
end $$;

create function public.mf_admin_brand_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  d jsonb := coalesce(p->'brand', '{}'::jsonb);
  v_code text;
begin
  if coalesce(trim(d->>'name'), '') = '' then raise exception 'Brand name required'; end if;
  v_code := coalesce(nullif(d->>'id', ''), 'BR-' || left(regexp_replace(upper(d->>'name'), '[^A-Z0-9]', '', 'g'), 8));
  insert into public.brands (vendor_id, code, name, logo_url, description, active, sort)
  values (c.vendor_id, v_code, trim(d->>'name'), coalesce(d->>'logo', ''), coalesce(d->>'desc', ''),
          private.mf_bool(d, 'active', true), private.mf_num(d, 'sort')::int)
  on conflict (vendor_id, code) do update set name = excluded.name, logo_url = excluded.logo_url,
    description = excluded.description, active = excluded.active, sort = excluded.sort;
  perform private.mf_audit(c.vendor_id, c.actor, 'brand_save', v_code);
  return jsonb_build_object('ok', true, 'id', v_code);
end $$;

create function public.mf_admin_brand_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); v_id uuid;
begin
  select b.id into v_id from public.brands b where b.vendor_id = c.vendor_id and b.code = p->>'id';
  if v_id is null then raise exception 'Not found'; end if;
  if exists (select 1 from public.products pr where pr.brand_id = v_id) then
    raise exception 'Brand has products — reassign them first';
  end if;
  delete from public.brands where id = v_id;
  perform private.mf_audit(c.vendor_id, c.actor, 'brand_delete', p->>'id');
  return jsonb_build_object('ok', true);
end $$;

/* ------------------------------------------------------------ accounts */

create function private.mf_addr_text(l1 text, l2 text, city text, state text, pin text, country text) returns text
language sql immutable set search_path = '' as $$
  select array_to_string(array_remove(array[nullif(l1, ''), nullif(l2, ''), nullif(city, ''),
           nullif(trim(coalesce(state, '') || ' ' || coalesce(pin, '')), ''), nullif(country, '')], null), ', ');
$$;

create function private.mf_company_id(v uuid, code text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.companies where vendor_id = v and code = $2;
$$;

create function public.mf_admin_companies(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  return jsonb_build_object('ok', true,
    'companies', coalesce((
      select jsonb_agg(row_to_json(x)::jsonb - 'sort_value' order by x.sort_value desc, x.name)
      from (
        select co.code as id, co.name, co.gstin, co.phone, co.email, co.billing_address, co.ship_address,
               co.state_code, co.owner_name as owner,
               lower(coalesce((select u.email from auth.users u where u.id = co.owner_user_id), '')) as owner_email,
               co.notes,
               jsonb_build_object('line1', co.bill_line1, 'line2', co.bill_line2, 'city', co.bill_city, 'state', co.bill_state, 'pin', co.bill_pin, 'country', co.bill_country) as bill,
               jsonb_build_object('line1', co.ship_line1, 'line2', co.ship_line2, 'city', co.ship_city, 'state', co.ship_state, 'pin', co.ship_pin, 'country', co.ship_country) as ship,
               co.ship_same, co.active, co.created_at::text as created,
               (select count(*) from public.contacts ct where ct.company_id = co.id) as contacts,
               (select count(*) from public.requests r where r.company_id = co.id) as orders,
               round(coalesce((select sum(coalesce(r.pi_total, r.total_est)) from public.requests r where r.company_id = co.id), 0)) as value,
               round(coalesce((select sum(coalesce(r.pi_total, r.total_est)) from public.requests r where r.company_id = co.id), 0)) as sort_value,
               (select count(*) from public.account_notes n where n.company_id = co.id) as notes_count,
               (select count(*) from public.account_files f where f.company_id = co.id) as files_count
          from public.companies co where co.vendor_id = c.vendor_id) x), '[]'::jsonb),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object('id', ct.code, 'company_id', co.code, 'name', ct.name, 'email', ct.email,
               'phone', ct.phone, 'role', ct.role, 'consent', ct.consent, 'consent_ts', coalesce(ct.consent_ts::text, ''),
               'consent_source', ct.consent_source, 'unsubscribed', ct.unsubscribed, 'created', ct.created_at::text) order by ct.code)
        from public.contacts ct join public.companies co on co.id = ct.company_id where ct.vendor_id = c.vendor_id), '[]'::jsonb),
    'unlinked_names', (select count(distinct lower(trim(r.company))) from public.requests r
                        where r.vendor_id = c.vendor_id and r.company_id is null and trim(r.company) <> ''),
    'unlinked_orders', (select count(*) from public.requests r
                         where r.vendor_id = c.vendor_id and r.company_id is null and trim(r.company) <> ''));
end $$;

create function public.mf_admin_company_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  d jsonb := coalesce(p->'company', '{}'::jsonb);
  b jsonb := coalesce(d->'bill', '{}'::jsonb);
  s jsonb;
  same boolean := coalesce((d->>'ship_same')::boolean, true);
  v_code text := nullif(d->>'id', '');
  v_owner uuid; v_owner_name text := coalesce(d->>'owner', '');
  v_bill text; v_ship text; v_state text;
begin
  if coalesce(trim(d->>'name'), '') = '' then raise exception 'Company name is required'; end if;
  s := case when same then b else coalesce(d->'ship', '{}'::jsonb) end;
  v_bill := coalesce(nullif(private.mf_addr_text(b->>'line1', b->>'line2', b->>'city', b->>'state', b->>'pin', coalesce(nullif(b->>'country', ''), 'India')), ''), coalesce(d->>'billing_address', ''));
  v_ship := case when same then v_bill
                 else coalesce(nullif(private.mf_addr_text(s->>'line1', s->>'line2', s->>'city', s->>'state', s->>'pin', coalesce(nullif(s->>'country', ''), 'India')), ''), coalesce(d->>'ship_address', '')) end;
  v_state := coalesce(nullif(trim(d->>'state_code'), ''),
                      (select g.code from private.gst_states g where lower(g.name) = lower(trim(coalesce(b->>'state', '')))),
                      substring(coalesce(d->>'gstin', '') from '^(\d{2})'), '');
  if coalesce(d->>'owner_email', '') <> '' then
    select m.user_id, coalesce(nullif(m.name, ''), m.email) into v_owner, v_owner_name
      from public.vendor_members m where m.vendor_id = c.vendor_id and lower(m.email) = lower(trim(d->>'owner_email'));
  end if;

  if v_code is null then v_code := private.mf_next_number(c.vendor_id, 'company', 'CO', false); end if;
  insert into public.companies as co (vendor_id, code, name, gstin, phone, email, billing_address, ship_address, state_code,
      owner_user_id, owner_name, notes, active, bill_line1, bill_line2, bill_city, bill_state, bill_pin, bill_country,
      ship_same, ship_line1, ship_line2, ship_city, ship_state, ship_pin, ship_country)
  values (c.vendor_id, v_code, trim(d->>'name'), upper(trim(coalesce(d->>'gstin', ''))), coalesce(d->>'phone', ''),
      coalesce(d->>'email', ''), v_bill, v_ship, v_state, v_owner, coalesce(v_owner_name, ''), coalesce(d->>'notes', ''),
      coalesce((d->>'active')::boolean, true),
      coalesce(b->>'line1', ''), coalesce(b->>'line2', ''), coalesce(b->>'city', ''), coalesce(b->>'state', ''),
      coalesce(b->>'pin', ''), coalesce(nullif(b->>'country', ''), 'India'), same,
      coalesce(s->>'line1', ''), coalesce(s->>'line2', ''), coalesce(s->>'city', ''), coalesce(s->>'state', ''),
      coalesce(s->>'pin', ''), coalesce(nullif(s->>'country', ''), 'India'))
  on conflict (vendor_id, code) do update set name = excluded.name, gstin = excluded.gstin, phone = excluded.phone,
      email = excluded.email, billing_address = excluded.billing_address, ship_address = excluded.ship_address,
      state_code = excluded.state_code, owner_user_id = excluded.owner_user_id, owner_name = excluded.owner_name,
      notes = excluded.notes, active = excluded.active, bill_line1 = excluded.bill_line1, bill_line2 = excluded.bill_line2,
      bill_city = excluded.bill_city, bill_state = excluded.bill_state, bill_pin = excluded.bill_pin,
      bill_country = excluded.bill_country, ship_same = excluded.ship_same, ship_line1 = excluded.ship_line1,
      ship_line2 = excluded.ship_line2, ship_city = excluded.ship_city, ship_state = excluded.ship_state,
      ship_pin = excluded.ship_pin, ship_country = excluded.ship_country, updated_at = now();
  perform private.mf_audit(c.vendor_id, c.actor, 'company_save', v_code, trim(d->>'name'));
  return jsonb_build_object('ok', true, 'id', v_code);
end $$;

create function public.mf_admin_company_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); v_id uuid := private.mf_company_id(c.vendor_id, p->>'id');
begin
  if v_id is null then raise exception 'Company not found'; end if;
  if exists (select 1 from public.requests r where r.company_id = v_id) then
    raise exception 'This company has orders against it. Deactivate it instead.';
  end if;
  delete from public.companies where id = v_id;    -- its contacts, notes and file rows go with it
  perform private.mf_audit(c.vendor_id, c.actor, 'company_delete', p->>'id');
  return jsonb_build_object('ok', true, 'id', p->>'id');
end $$;

create function public.mf_admin_contact_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  d jsonb := coalesce(p->'contact', '{}'::jsonb);
  v_co uuid;
  v_code text := nullif(d->>'id', '');
  old public.contacts;
  v_consent boolean := private.mf_bool(d, 'consent');
begin
  if coalesce(d->>'company_id', '') = '' then raise exception 'A contact must belong to a company'; end if;
  v_co := private.mf_company_id(c.vendor_id, d->>'company_id');
  if v_co is null then raise exception 'Company not found'; end if;
  if coalesce(d->>'name', '') = '' and coalesce(d->>'email', '') = '' then raise exception 'Give the contact a name or an email'; end if;
  if coalesce(d->>'email', '') <> '' and not private.mf_valid_email(d->>'email') then raise exception 'Invalid email'; end if;

  if v_code is not null then
    select * into old from public.contacts ct where ct.vendor_id = c.vendor_id and ct.code = v_code;
  else
    v_code := private.mf_next_number(c.vendor_id, 'contact', 'CT', false);
  end if;
  -- Consent is only meaningful with a record of when and where it came from.
  insert into public.contacts as ct (vendor_id, code, company_id, name, email, phone, role, consent, consent_ts, consent_source, unsubscribed)
  values (c.vendor_id, v_code, v_co, coalesce(d->>'name', ''), trim(coalesce(d->>'email', '')), coalesce(d->>'phone', ''),
          coalesce(d->>'role', ''), v_consent,
          case when v_consent then coalesce(case when old.consent then old.consent_ts end, now()) end,
          case when v_consent then coalesce(nullif(d->>'consent_source', ''), case when old.consent then old.consent_source end, 'recorded in console') else '' end,
          private.mf_bool(d, 'unsubscribed'))
  on conflict (vendor_id, code) do update set company_id = excluded.company_id, name = excluded.name, email = excluded.email,
      phone = excluded.phone, role = excluded.role, consent = excluded.consent, consent_ts = excluded.consent_ts,
      consent_source = excluded.consent_source, unsubscribed = excluded.unsubscribed;
  perform private.mf_audit(c.vendor_id, c.actor, 'contact_save', v_code, coalesce(nullif(d->>'email', ''), d->>'name'));
  return jsonb_build_object('ok', true, 'id', v_code);
end $$;

create function public.mf_admin_contact_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  delete from public.contacts where vendor_id = c.vendor_id and code = p->>'id';
  if not found then raise exception 'Contact not found'; end if;
  perform private.mf_audit(c.vendor_id, c.actor, 'contact_delete', p->>'id');
  return jsonb_build_object('ok', true, 'id', p->>'id');
end $$;

-- Orders raised with a free-text company name: one company per normalised
-- name, the order linked to it, and a contact lifted from its most recent
-- order. Idempotent; existing companies with the same name are reused.
create function public.mf_admin_company_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  g record; v_co uuid; made_co int := 0; made_ct int := 0; linked int := 0; n int;
begin
  for g in
    select lower(regexp_replace(regexp_replace(trim(r.company), '\s+', ' ', 'g'), '[.,]', '', 'g')) as k,
           (array_agg(r.company order by r.created_at desc))[1] as name,
           (array_agg(r.gstin order by r.created_at desc))[1] as gstin,
           (array_agg(r.contact order by r.created_at desc))[1] as contact,
           (array_agg(r.email order by r.created_at desc))[1] as email,
           (array_agg(r.phone order by r.created_at desc))[1] as phone,
           (array_agg(r.ship_address order by r.created_at desc))[1] as ship
      from public.requests r
     where r.vendor_id = c.vendor_id and r.company_id is null and trim(r.company) <> ''
     group by 1
  loop
    select co.id into v_co from public.companies co
     where co.vendor_id = c.vendor_id
       and lower(regexp_replace(regexp_replace(trim(co.name), '\s+', ' ', 'g'), '[.,]', '', 'g')) = g.k;
    if v_co is null then
      insert into public.companies (vendor_id, code, name, gstin, billing_address, ship_address, state_code)
      values (c.vendor_id, private.mf_next_number(c.vendor_id, 'company', 'CO', false), trim(g.name), upper(coalesce(g.gstin, '')),
              coalesce(g.ship, ''), coalesce(g.ship, ''), coalesce(substring(g.gstin from '^(\d{2})'), ''))
      returning id into v_co;
      made_co := made_co + 1;
    end if;
    update public.requests r set company_id = v_co
     where r.vendor_id = c.vendor_id and r.company_id is null
       and lower(regexp_replace(regexp_replace(trim(r.company), '\s+', ' ', 'g'), '[.,]', '', 'g')) = g.k;
    get diagnostics n = row_count; linked := linked + n;
    if coalesce(g.email, '') <> '' and not exists (select 1 from public.contacts ct where ct.company_id = v_co and lower(ct.email) = lower(g.email)) then
      insert into public.contacts (vendor_id, code, company_id, name, email, phone, consent)
      values (c.vendor_id, private.mf_next_number(c.vendor_id, 'contact', 'CT', false), v_co, coalesce(g.contact, ''), g.email, coalesce(g.phone, ''), false);
      made_ct := made_ct + 1;
    end if;
  end loop;
  perform private.mf_audit(c.vendor_id, c.actor, 'company_import', '', made_co || ' companies, ' || made_ct || ' contacts, ' || linked || ' orders linked');
  return jsonb_build_object('ok', true, 'companies', made_co, 'contacts', made_ct, 'linked', linked);
end $$;

create function public.mf_admin_account_notes(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); v_co uuid;
begin
  if coalesce(p->>'company_id', '') = '' then raise exception 'company_id required'; end if;
  v_co := private.mf_company_id(c.vendor_id, p->>'company_id');
  return jsonb_build_object('ok', true,
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'company_id', p->>'company_id', 'ts', n.created_at::text,
                         'author', n.author, 'text', n.text) order by n.created_at desc)
                       from public.account_notes n where n.company_id = v_co), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'company_id', p->>'company_id', 'name', f.name,
                         'path', f.path, 'mime', f.mime, 'size', f.size, 'uploaded_by', f.uploaded_by, 'ts', f.created_at::text) order by f.created_at desc)
                       from public.account_files f where f.company_id = v_co), '[]'::jsonb));
end $$;

create function public.mf_admin_account_note_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  v_text text := left(trim(coalesce(p->>'text', '')), 4000);
  n public.account_notes; v_co uuid;
begin
  if v_text = '' then raise exception 'Write something first'; end if;
  if coalesce(p->>'id', '') <> '' then
    update public.account_notes set text = v_text where id = (p->>'id')::uuid and vendor_id = c.vendor_id returning * into n;
    if n.id is null then raise exception 'Note not found'; end if;
    perform private.mf_audit(c.vendor_id, c.actor, 'account_note_edit', '', n.id::text);
  else
    v_co := private.mf_company_id(c.vendor_id, p->>'company_id');
    if v_co is null then raise exception 'Account not found'; end if;
    insert into public.account_notes (vendor_id, company_id, author, text) values (c.vendor_id, v_co, c.actor, v_text) returning * into n;
    perform private.mf_audit(c.vendor_id, c.actor, 'account_note', p->>'company_id', n.id::text);
  end if;
  return jsonb_build_object('ok', true, 'note', jsonb_build_object('id', n.id,
    'company_id', (select co.code from public.companies co where co.id = n.company_id),
    'ts', n.created_at::text, 'author', n.author, 'text', n.text));
end $$;

create function public.mf_admin_account_note_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  delete from public.account_notes where vendor_id = c.vendor_id and id::text = coalesce(p->>'id', '');
  if not found then raise exception 'Note not found'; end if;
  perform private.mf_audit(c.vendor_id, c.actor, 'account_note_delete', '', p->>'id');
  return jsonb_build_object('ok', true);
end $$;

/* ------------------------------------------------------------ grants */

revoke execute on all functions in schema public, private from public, anon;
grant execute on function
  public.mf_admin_catalog(jsonb), public.mf_admin_product_save(jsonb), public.mf_admin_product_delete(jsonb),
  public.mf_admin_brand_save(jsonb), public.mf_admin_brand_delete(jsonb),
  public.mf_admin_companies(jsonb), public.mf_admin_company_save(jsonb), public.mf_admin_company_delete(jsonb),
  public.mf_admin_company_import(jsonb), public.mf_admin_contact_save(jsonb), public.mf_admin_contact_delete(jsonb),
  public.mf_admin_account_notes(jsonb), public.mf_admin_account_note_save(jsonb), public.mf_admin_account_note_delete(jsonb)
to authenticated;
-- RLS policies still call these as the signed-in user.
grant execute on function private.mf_is_platform_admin(), private.mf_is_member(uuid), private.mf_is_vendor_admin(uuid) to authenticated;
