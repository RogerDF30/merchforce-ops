-- Merchforce on Supabase — products from the sheet: review notice and image import.
--
-- 1. A product created by a sheet sync arrives hidden AND flagged for review,
--    so the console can say "N new products from your sheet are hidden".
--    Showing or keeping them hidden (or saving the product) clears the flag.
-- 2. The sheet's 'Image URL' column (one or more links, comma separated) is
--    imported: the sync queues the links, the sync tick downloads each image
--    into the vendor's images folder, and the product points at our copy.
--    A link is fetched again only when the vendor changes it.

alter table public.products
  add column review_pending boolean not null default false,
  add column image_sources text[] not null default '{}',   -- the vendor's links the current images came from
  add column image_error text not null default '';

alter table private.outbox drop constraint outbox_kind_check;
alter table private.outbox add constraint outbox_kind_check check (kind in ('mail', 'writeback', 'image'));

create or replace function private.mf_sync_fields() returns text[] language sql immutable set search_path = '' as $$
  select array['on_hand', 'price', 'mrp', 'moq', 'gst_rate', 'hsn', 'name', 'lead_time', 'description', 'category', 'subcategory', 'images'];
$$;

-- Links from a sheet cell: http(s) URLs split on commas, semicolons, spaces or new lines.
create function private.mf_url_list(v text) returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(u order by ord), '{}') from (
    select trim(u) as u, ord from regexp_split_to_table(coalesce(v, ''), '[,;\s]+') with ordinality as t(u, ord)) x
   where u ~* '^https?://';
$$;

-- Queue an image import when the sheet's links differ from what the images came from.
create function private.mf_queue_images(pr public.products, urls text[]) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(array_length(urls, 1), 0) = 0 or urls = pr.image_sources then return false; end if;
  update public.products set image_sources = urls, image_error = '' where id = pr.id;
  perform private.mf_enqueue(pr.vendor_id, 'image', jsonb_build_object('sku', pr.sku, 'urls', to_jsonb(urls)));
  return true;
end $$;

/* ------------------------------------------------------------ sync apply: images + review flag */

create or replace function public.mf_service_sync_apply(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v uuid := (p->>'vendor_id')::uuid;
  m public.sync_maps;
  v_brand text; v_brand_id uuid; actor text := coalesce(p->>'actor', 'sync');
  inc jsonb := '{}'::jsonb; e jsonb; k text; vals jsonb; f text; val jsonb;
  pr public.products; ft public.price_tiers; changed boolean; nxt text; n numeric; rc int;
  s jsonb := jsonb_build_object('ts', now()::text, 'matched', 0, 'updated', 0, 'unchanged', 0, 'kept', 0, 'created', 0,
                                'unknown', 0, 'off_brand', 0, 'images_queued', 0, 'unknown_skus', '[]'::jsonb, 'created_skus', '[]'::jsonb, 'error', null);
  created text[] := '{}';
begin
  select * into m from public.sync_maps where id = (p->>'map_id')::uuid and vendor_id = v;
  if m.id is null then raise exception 'Mapping not found'; end if;
  if coalesce(p->>'error', '') <> '' then
    s := s || jsonb_build_object('error', p->>'error');
    update public.sync_maps set last = s where id = m.id;
    perform private.mf_audit(v, actor, 'sheet_sync', coalesce(nullif(m.config->>'brand', ''), 'all'), p->>'error');
    return s;
  end if;
  v_brand := coalesce(m.config->>'brand', '');
  select b.id into v_brand_id from public.brands b where b.vendor_id = v and b.code = v_brand;

  for e in select x from jsonb_array_elements(coalesce(p->'incoming', '[]'::jsonb)) x loop
    k := upper(trim(e->>'sku'));
    continue when k = '';
    inc := inc || jsonb_build_object(k, jsonb_build_object('sku', trim(e->>'sku'),
                    'values', coalesce(inc->k->'values', '{}'::jsonb) || coalesce(e->'values', '{}'::jsonb)));
  end loop;

  for pr in select * from public.products x where x.vendor_id = v and inc ? upper(x.sku) order by x.sku for update loop
    vals := inc->upper(pr.sku)->'values';
    if v_brand <> '' and pr.brand_id is distinct from v_brand_id then
      s := jsonb_set(s, '{off_brand}', to_jsonb((s->>'off_brand')::int + 1)); continue;
    end if;
    s := jsonb_set(s, '{matched}', to_jsonb((s->>'matched')::int + 1));
    changed := false;
    for f, val in select * from jsonb_each(vals) loop
      continue when val = 'null'::jsonb or not (f = any (private.mf_sync_fields()));
      if f = 'images' then
        if private.mf_queue_images(pr, private.mf_url_list(val#>>'{}')) then
          s := jsonb_set(s, '{images_queued}', to_jsonb((s->>'images_queued')::int + 1)); changed := true;
        end if;
      elsif f = 'price' then
        select * into ft from public.price_tiers t where t.product_id = pr.id order by t.min_qty limit 1;
        if ft.id is null then
          insert into public.price_tiers (vendor_id, product_id, min_qty, unit_price) values (v, pr.id, pr.moq, (val#>>'{}')::numeric);
          changed := true;
        elsif ft.unit_price <> (val#>>'{}')::numeric then
          update public.price_tiers set unit_price = (val#>>'{}')::numeric where id = ft.id; changed := true;
        end if;
        ft := null;
      elsif f = 'on_hand' then
        n := floor((val#>>'{}')::numeric);
        if pr.sync_seen is not null and pr.sync_seen = n then
          if pr.on_hand <> n then s := jsonb_set(s, '{kept}', to_jsonb((s->>'kept')::int + 1)); end if;
          continue;
        end if;
        update public.products set sync_seen = n where id = pr.id;
        if pr.on_hand <> n then
          update public.products set on_hand = n, updated_at = now() where id = pr.id;
          insert into public.stock_log (vendor_id, sku, delta, reason, actor)
          values (v, pr.sku, n - pr.on_hand, 'sheet sync' || case when v_brand <> '' then ' (' || v_brand || ')' else '' end, actor);
          changed := true;
        end if;
      elsif f in ('mrp', 'moq', 'gst_rate') then
        n := (val#>>'{}')::numeric;
        execute format('update public.products set %I = $1, updated_at = now() where id = $2 and %I is distinct from $1', f, f)
          using case when f = 'moq' then greatest(1, floor(n)) else n end, pr.id;
        get diagnostics rc = row_count;
        if rc > 0 then changed := true; end if;
      else
        nxt := val#>>'{}';
        continue when nxt = '';                     -- a blank cell leaves the field alone
        execute format('update public.products set %I = $1, updated_at = now() where id = $2 and %I is distinct from $1', f, f)
          using nxt, pr.id;
        get diagnostics rc = row_count;
        if rc > 0 then changed := true; end if;
      end if;
    end loop;
    if changed then s := jsonb_set(s, '{updated}', to_jsonb((s->>'updated')::int + 1));
    else s := jsonb_set(s, '{unchanged}', to_jsonb((s->>'unchanged')::int + 1)); end if;
  end loop;

  for k, e in select * from jsonb_each(inc) loop
    continue when exists (select 1 from public.products x where x.vendor_id = v and upper(x.sku) = k);
    vals := e->'values';
    if coalesce((m.config->>'create_new')::boolean, false) then
      insert into public.products (vendor_id, sku, name, brand_id, category, subcategory, description, moq, gst_rate,
                                   lead_time, on_hand, sync_seen, visible, show_price, mrp, hsn, review_pending)
      values (v, upper(e->>'sku'), coalesce(nullif(vals->>'name', ''), e->>'sku'), v_brand_id,
              coalesce(vals->>'category', ''), coalesce(vals->>'subcategory', ''), coalesce(vals->>'description', ''),
              greatest(1, coalesce(floor((vals->>'moq')::numeric), 1)), coalesce((vals->>'gst_rate')::numeric, 18),
              coalesce(vals->>'lead_time', ''), coalesce(floor((vals->>'on_hand')::numeric), 0), floor((vals->>'on_hand')::numeric),
              false, true, nullif((vals->>'mrp')::numeric, 0), coalesce(vals->>'hsn', ''), true)
      returning * into pr;
      if (vals->>'price') is not null then
        insert into public.price_tiers (vendor_id, product_id, min_qty, unit_price) values (v, pr.id, pr.moq, (vals->>'price')::numeric);
      end if;
      if private.mf_queue_images(pr, private.mf_url_list(vals->>'images')) then
        s := jsonb_set(s, '{images_queued}', to_jsonb((s->>'images_queued')::int + 1));
      end if;
      created := created || pr.sku;
      s := jsonb_set(s, '{created}', to_jsonb((s->>'created')::int + 1));
      if jsonb_array_length(s->'created_skus') < 20 then s := jsonb_set(s, '{created_skus}', (s->'created_skus') || to_jsonb(pr.sku)); end if;
    else
      s := jsonb_set(s, '{unknown}', to_jsonb((s->>'unknown')::int + 1));
      if jsonb_array_length(s->'unknown_skus') < 20 then s := jsonb_set(s, '{unknown_skus}', (s->'unknown_skus') || to_jsonb(e->>'sku')); end if;
    end if;
  end loop;
  if array_length(created, 1) > 0 and coalesce((m.config->>'write_back')::boolean, false) then
    perform private.mf_enqueue(v, 'writeback', jsonb_build_object('skus', to_jsonb(created)));
  end if;

  update public.sync_maps set last = s where id = m.id;
  perform private.mf_audit(v, actor, 'sheet_sync', coalesce(nullif(v_brand, ''), 'all') || ':' || (m.config->>'sheet'),
                           (s->>'updated') || ' updated, ' || (s->>'created') || ' created, ' || (s->>'unknown') || ' unknown');
  return s;
end $$;

/* ------------------------------------------------------------ image import (service) */

create function public.mf_service_image_batch(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare out jsonb;
begin
  with picked as (
    select o.id from private.outbox o where o.kind = 'image' and o.sent_at is null and o.attempts < 3
     order by o.id limit 20 for update skip locked),
  bumped as (update private.outbox o set attempts = o.attempts + 1 from picked where o.id = picked.id
             returning o.id, o.vendor_id, o.payload)
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'vendor_id', b.vendor_id, 'sku', b.payload->>'sku', 'urls', b.payload->'urls')), '[]'::jsonb)
    into out from bumped b;
  return jsonb_build_object('ok', true, 'jobs', out);
end $$;

-- Point the product at the imported copies (only if its links have not changed again meanwhile).
create function public.mf_service_image_done(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v uuid := (p->>'vendor_id')::uuid;
begin
  update public.products set
    images = case when jsonb_array_length(coalesce(p->'images', '[]'::jsonb)) > 0
                  then (select array_agg(x) from jsonb_array_elements_text(p->'images') x) else images end,
    image_error = left(coalesce(p->>'error', ''), 500), updated_at = now()
  where vendor_id = v and upper(sku) = upper(p->>'sku')
    and image_sources = (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text(coalesce(p->'urls', '[]'::jsonb)) x);
  update private.outbox set sent_at = now(), error = left(coalesce(p->>'error', ''), 500) where id = (p->>'id')::bigint;
  return jsonb_build_object('ok', true);
end $$;

/* ------------------------------------------------------------ review */

-- Show or keep hidden products that arrived from the sheet; clears the review flag.
create function public.mf_admin_product_review(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); n int;
begin
  update public.products set review_pending = false,
         visible = case when private.mf_bool(p, 'show') then true else visible end, updated_at = now()
   where vendor_id = c.vendor_id
     and upper(sku) in (select upper(x) from jsonb_array_elements_text(coalesce(p->'skus', '[]'::jsonb)) x);
  get diagnostics n = row_count;
  perform private.mf_audit(c.vendor_id, c.actor, 'product_review', '', n || ' products ' || case when private.mf_bool(p, 'show') then 'shown' else 'kept hidden' end);
  return jsonb_build_object('ok', true, 'reviewed', n);
end $$;

-- Showing or hiding a product in the editor is a review too.
create function private.mf_clear_review() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.visible is distinct from old.visible then new.review_pending := false; end if;
  return new;
end $$;
create trigger products_clear_review before update on public.products for each row execute function private.mf_clear_review();

-- The catalogue carries the flags; mf_me carries the notice for the header.
create or replace function private.mf_product_out(pr public.products) returns jsonb
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
    'review_pending', pr.review_pending, 'image_error', pr.image_error,
    'images_pending', exists (select 1 from private.outbox o where o.kind = 'image' and o.sent_at is null and o.attempts < 3
                               and o.vendor_id = pr.vendor_id and upper(o.payload->>'sku') = upper(pr.sku)),
    'tiers', coalesce((select jsonb_agg(jsonb_build_object('min', t.min_qty, 'price', t.unit_price,
                                                           'gst', coalesce(to_jsonb(t.gst), '""'::jsonb)) order by t.min_qty)
                       from public.price_tiers t where t.product_id = pr.id), '[]'::jsonb));
$$;

create or replace function public.mf_me(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); s jsonb; n_review int; n_img int;
begin
  update public.vendor_members set last_login = now() where vendor_id = c.vendor_id and user_id = c.user_id;
  s := private.mf_settings(c.vendor_id);
  select count(*) filter (where review_pending), count(*) filter (where image_error <> '')
    into n_review, n_img from public.products where vendor_id = c.vendor_id;
  return jsonb_build_object('ok', true,
    'user', jsonb_build_object('email', c.email, 'name', c.actor, 'role', c.role),
    'vendor', (select jsonb_build_object('slug', v.slug, 'name', v.name) from public.vendors v where v.id = c.vendor_id),
    'settings', s, 'session_minutes', (s->>'session_minutes')::int,
    'notices', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
       select jsonb_build_object('type', 'products_review', 'count', n_review, 'tab', 'catalog',
              'text', n_review || ' new product' || case when n_review = 1 then '' else 's' end ||
                      ' from your stock sheet ' || case when n_review = 1 then 'is' else 'are' end || ' hidden. Review them to make them available.') as x
        where n_review > 0
       union all
       select jsonb_build_object('type', 'image_errors', 'count', n_img, 'tab', 'catalog',
              'text', n_img || ' product image link' || case when n_img = 1 then '' else 's' end ||
                      ' from your sheet could not be imported. Check that the links are public.')
        where n_img > 0) y));
end $$;

/* ------------------------------------------------------------ template gets an Image URL column */

create or replace function public.mf_service_template_link(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v uuid := (p->>'vendor_id')::uuid; t jsonb;
  fields jsonb := '[{"col":"Product Name","field":"name"},{"col":"HSN","field":"hsn"},{"col":"GST %","field":"gst_rate"},
                    {"col":"MRP","field":"mrp"},{"col":"Selling Price Excluding GST","field":"price"},{"col":"Stock","field":"on_hand"},
                    {"col":"MOQ","field":"moq"},{"col":"Lead Time","field":"lead_time"},{"col":"Image URL","field":"images"}]'::jsonb;
begin
  for t in select x from jsonb_array_elements(coalesce(p->'tabs', '[]'::jsonb)) x loop
    delete from public.sync_maps where vendor_id = v and coalesce(config->>'brand', '') = coalesce(t->>'brand', '');
    insert into public.sync_maps (vendor_id, position, config)
    values (v, coalesce((select max(position) + 1 from public.sync_maps where vendor_id = v), 0),
            jsonb_build_object('mode', 'pull', 'brand', coalesce(t->>'brand', ''), 'sheet', p->>'sheet', 'tab', t->>'tab',
              'sku_col', 'Code', 'fields', fields,
              'sources', jsonb_build_array(jsonb_build_object('tab', t->>'tab', 'sku_col', 'Code', 'fields', fields)),
              'create_new', true, 'write_back', true));
  end loop;
  -- what the sheet shows now is what we wrote: neither stock nor images count as vendor edits on the first sync
  update public.products set sync_seen = on_hand, image_sources = images where vendor_id = v;
  perform private.mf_audit(v, coalesce(p->>'actor', 'admin'), 'sync_template', p->>'sheet', jsonb_array_length(coalesce(p->'tabs', '[]'::jsonb)) || ' tabs');
  return jsonb_build_object('ok', true, 'maps', private.mf_sync_maps_json(v));
end $$;

create or replace function public.mf_service_template_data(p jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  with v as (select (p->>'vendor_id')::uuid as id),
  rows as (
    select pr.*, coalesce(b.code, '') as brand_code,
           (select t.unit_price from public.price_tiers t where t.product_id = pr.id order by t.min_qty limit 1) as price
      from public.products pr left join public.brands b on b.id = pr.brand_id, v where pr.vendor_id = v.id)
  select jsonb_build_object('ok', true,
    'brands', (select coalesce(jsonb_agg(jsonb_build_object('code', b.code, 'name', b.name) order by b.sort, b.name), '[]'::jsonb)
                 from public.brands b, v where b.vendor_id = v.id and (coalesce(p->>'brand', '') = '' or b.code = p->>'brand')),
    'products', (select coalesce(jsonb_agg(jsonb_build_object('sku', r.sku, 'name', r.name, 'brand', r.brand_code, 'hsn', r.hsn,
                   'gst_rate', r.gst_rate, 'mrp', r.mrp, 'price', r.price, 'on_hand', r.on_hand, 'reserved', r.reserved,
                   'atp', private.mf_atp(r.on_hand, r.reserved, r.safety_stock), 'moq', r.moq, 'lead_time', r.lead_time,
                   'images', array_to_string(r.images, ', ')) order by r.sku), '[]'::jsonb)
                 from rows r));
$$;

revoke execute on all functions in schema public, private from public, anon;
grant execute on function public.mf_admin_product_review(jsonb), public.mf_me(jsonb) to authenticated;
grant execute on function public.mf_service_image_batch(jsonb), public.mf_service_image_done(jsonb) to service_role;
grant execute on function public.mf_order_view(jsonb), public.mf_order_pi_respond(jsonb), public.mf_order_po_upload(jsonb) to anon, authenticated;
grant execute on function private.mf_is_platform_admin(), private.mf_is_member(uuid), private.mf_is_vendor_admin(uuid), private.mf_member_of_path(text) to authenticated;

-- The sync tick also wakes for pending image imports.
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'mf-sync-tick';
    perform cron.schedule('mf-sync-tick', '* * * * *', $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'mf_functions_url') || '/sync',
        headers := jsonb_build_object('Content-Type', 'application/json',
                     'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mf_cron_secret')),
        body := '{"action":"tick"}'::jsonb)
      where exists (select 1 from private.outbox where kind in ('writeback', 'image') and sent_at is null and attempts < 5)
         or exists (select 1 from public.vendor_settings where settings->>'sync_auto' in ('live5', 'hourly', 'daily'))
    $job$);
  end if;
end $$;
