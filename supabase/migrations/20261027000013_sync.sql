-- Merchforce on Supabase — Google Sheet stock sync. Ports StockSync.gs (pull mode).
--
-- A vendor shares their stock sheet with Merchforce's service account. A
-- mapping says which columns feed which product fields (sources may span
-- tabs, joined on each tab's SKU column). The 'sync' edge function reads the
-- sheet and hands the rows to mf_service_sync_apply, which updates products
-- here. With write-back on, every stock or hold change is written into the
-- sheet's Stock / Committed / Available columns from the outbox.
--
-- Change detection: on hand from the sheet only overrides the app when the
-- vendor actually changed the cell (products.sync_seen remembers what was last
-- read or written), so the app's own movements are never undone by a sync.

create function private.mf_sync_fields() returns text[] language sql immutable set search_path = '' as $$
  select array['on_hand', 'price', 'mrp', 'moq', 'gst_rate', 'hsn', 'name', 'lead_time', 'description', 'category', 'subcategory'];
$$;

create function private.mf_sheet_id(v text) returns text language sql immutable set search_path = '' as $$
  select coalesce(substring(coalesce(v, '') from '/d/([A-Za-z0-9_-]{20,})'), trim(coalesce(v, '')));
$$;

-- The mappings as the console knows them: an ordered array, addressed by index.
create function private.mf_sync_maps_json(v uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(m.config || jsonb_build_object('last', m.last, 'write_back_last', m.write_back_last, 'id', m.id)
                  order by m.position, m.id), '[]'::jsonb)
    from public.sync_maps m where m.vendor_id = v;
$$;

-- Settings carry sync_maps as a JSON string, the shape the console reads.
create or replace function public.mf_admin_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p, true); patch jsonb := coalesce(p->'save', '{}'::jsonb); sec public.vendor_secrets;
begin
  if patch ? 'relay_secret' then
    insert into public.vendor_secrets (vendor_id, relay_secret) values (c.vendor_id, coalesce(patch->>'relay_secret', ''))
    on conflict (vendor_id) do update set relay_secret = excluded.relay_secret;
    patch := patch - 'relay_secret';
  end if;
  if patch <> '{}'::jsonb then
    select coalesce(jsonb_object_agg(key, to_jsonb(value)), '{}'::jsonb) into patch
      from jsonb_each_text(patch) where private.mf_default_settings() ? key;
    insert into public.vendor_settings (vendor_id, settings) values (c.vendor_id, patch)
    on conflict (vendor_id) do update set settings = public.vendor_settings.settings || excluded.settings, updated_at = now();
    perform private.mf_audit(c.vendor_id, c.actor, 'settings_save', '', (select string_agg(k, ', ') from jsonb_object_keys(patch) k));
  end if;
  select * into sec from public.vendor_secrets s where s.vendor_id = c.vendor_id;
  return jsonb_build_object('ok', true,
    'settings', private.mf_settings(c.vendor_id)
                || jsonb_build_object('relay_secret', coalesce(sec.relay_secret, ''),
                                      'sync_maps', private.mf_sync_maps_json(c.vendor_id)::text),
    'relay_status', sec.relay_last,
    'sync_account', 'merchforce-sheets@merchforce.iam.gserviceaccount.com');
end $$;

/* ------------------------------------------------------------ mappings */

create function public.mf_admin_sync_map_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p, true);
  m jsonb := coalesce(p->'map', '{}'::jsonb);
  v_sheet text := private.mf_sheet_id(m->>'sheet');
  sources jsonb; rec jsonb; v_id uuid;
begin
  if m->>'mode' = 'push' then
    raise exception 'Push mappings are not available in this version: share the sheet with Merchforce and use a pull mapping';
  end if;
  if coalesce(m->>'brand', '') <> '' and not exists (select 1 from public.brands b where b.vendor_id = c.vendor_id and b.code = m->>'brand') then
    raise exception 'Unknown brand: %', m->>'brand';
  end if;
  -- one source per tab used; legacy single-tab maps become one source
  select coalesce(jsonb_agg(jsonb_build_object('tab', coalesce(s->>'tab', ''), 'sku_col', s->>'sku_col', 'fields', f.fields)), '[]'::jsonb)
    into sources
    from jsonb_array_elements(case when jsonb_array_length(coalesce(m->'sources', '[]'::jsonb)) > 0 then m->'sources'
                                   else jsonb_build_array(jsonb_build_object('tab', m->>'tab', 'sku_col', m->>'sku_col', 'fields', m->'fields')) end) s
    cross join lateral (select coalesce(jsonb_agg(x), '[]'::jsonb) as fields
                          from jsonb_array_elements(coalesce(s->'fields', '[]'::jsonb)) x
                         where coalesce(x->>'col', '') <> '' and x->>'field' = any (private.mf_sync_fields())) f
   where coalesce(s->>'sku_col', '') <> '' and jsonb_array_length(f.fields) > 0;
  if v_sheet = '' or jsonb_array_length(sources) = 0 then
    raise exception 'Sheet, SKU column and at least one field mapping are required';
  end if;
  rec := jsonb_build_object('mode', 'pull', 'brand', coalesce(m->>'brand', ''), 'sheet', v_sheet,
           'tab', coalesce(sources->0->>'tab', ''), 'sku_col', sources->0->>'sku_col', 'fields', sources->0->'fields',
           'sources', sources, 'create_new', private.mf_bool(m, 'create_new'),
           'write_back', coalesce(m->>'write_back', 'true') not in ('false', '0'));
  if p ? 'index' and p->>'index' <> '' then
    select id into v_id from public.sync_maps where vendor_id = c.vendor_id order by position, id offset (p->>'index')::int limit 1;
  end if;
  if v_id is not null then
    update public.sync_maps set config = rec where id = v_id;
  else
    insert into public.sync_maps (vendor_id, position, config)
    values (c.vendor_id, coalesce((select max(position) + 1 from public.sync_maps where vendor_id = c.vendor_id), 0), rec);
  end if;
  perform private.mf_audit(c.vendor_id, c.actor, 'sync_map_save', coalesce(nullif(m->>'brand', ''), 'all'), v_sheet);
  return jsonb_build_object('ok', true, 'maps', private.mf_sync_maps_json(c.vendor_id));
end $$;

create function public.mf_admin_sync_map_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p, true); v_id uuid;
begin
  select id into v_id from public.sync_maps where vendor_id = c.vendor_id order by position, id offset coalesce((p->>'index')::int, -1) limit 1;
  if v_id is null then raise exception 'Mapping not found'; end if;
  delete from public.sync_maps where id = v_id;
  return jsonb_build_object('ok', true, 'maps', private.mf_sync_maps_json(c.vendor_id));
end $$;

-- off | live5 | hourly | daily. The scheduled job reads this; nothing per vendor to install.
create function public.mf_admin_sync_schedule(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p, true);
        v_mode text := case when p->>'mode' in ('live5', 'hourly', 'daily') then p->>'mode' else 'off' end;
begin
  insert into public.vendor_settings (vendor_id, settings) values (c.vendor_id, jsonb_build_object('sync_auto', v_mode))
  on conflict (vendor_id) do update set settings = public.vendor_settings.settings || excluded.settings, updated_at = now();
  perform private.mf_audit(c.vendor_id, c.actor, 'sync_schedule', '', v_mode);
  return jsonb_build_object('ok', true, 'mode', v_mode);
end $$;

/* ------------------------------------------------------------ service: read & apply */

-- The edge function checks the caller with this (admin only) and gets the maps.
create function public.mf_admin_sync_maps(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p, true);
begin
  return jsonb_build_object('ok', true, 'vendor_id', c.vendor_id, 'actor', c.actor, 'maps', private.mf_sync_maps_json(c.vendor_id));
end $$;

-- incoming: [{sku, values: {field: value | null}}] merged across the map's tabs.
create function public.mf_service_sync_apply(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v uuid := (p->>'vendor_id')::uuid;
  m public.sync_maps;
  v_brand text; v_brand_id uuid; actor text := coalesce(p->>'actor', 'sync');
  inc jsonb := '{}'::jsonb; e jsonb; k text; vals jsonb; f text; val jsonb;
  pr public.products; ft public.price_tiers; changed boolean; cur text; nxt text; n numeric; rc int;
  s jsonb := jsonb_build_object('ts', now()::text, 'matched', 0, 'updated', 0, 'unchanged', 0, 'kept', 0, 'created', 0,
                                'unknown', 0, 'off_brand', 0, 'unknown_skus', '[]'::jsonb, 'created_skus', '[]'::jsonb, 'error', null);
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
      if f = 'price' then
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
        -- the sheet only overrides when the vendor changed the cell since we last read or wrote it
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
        get diagnostics rc = row_count;          -- EXECUTE does not set FOUND
        if rc > 0 then changed := true; end if;
      else
        nxt := val#>>'{}';
        execute format('update public.products set %I = $1, updated_at = now() where id = $2 and %I is distinct from $1', f, f)
          using nxt, pr.id;
        get diagnostics rc = row_count;
        if rc > 0 then changed := true; end if;
      end if;
    end loop;
    if changed then s := jsonb_set(s, '{updated}', to_jsonb((s->>'updated')::int + 1));
    else s := jsonb_set(s, '{unchanged}', to_jsonb((s->>'unchanged')::int + 1)); end if;
  end loop;

  -- rows in the sheet that are not in the catalogue
  for k, e in select * from jsonb_each(inc) loop
    continue when exists (select 1 from public.products x where x.vendor_id = v and upper(x.sku) = k);
    vals := e->'values';
    if coalesce((m.config->>'create_new')::boolean, false) then
      insert into public.products (vendor_id, sku, name, brand_id, category, subcategory, description, moq, gst_rate,
                                   lead_time, on_hand, sync_seen, visible, show_price, mrp, hsn)
      values (v, upper(e->>'sku'), coalesce(nullif(vals->>'name', ''), e->>'sku'), v_brand_id,
              coalesce(vals->>'category', ''), coalesce(vals->>'subcategory', ''), coalesce(vals->>'description', ''),
              greatest(1, coalesce(floor((vals->>'moq')::numeric), 1)), coalesce((vals->>'gst_rate')::numeric, 18),
              coalesce(vals->>'lead_time', ''), coalesce(floor((vals->>'on_hand')::numeric), 0), floor((vals->>'on_hand')::numeric),
              false, true, nullif((vals->>'mrp')::numeric, 0), coalesce(vals->>'hsn', ''))
      returning * into pr;
      if (vals->>'price') is not null then
        insert into public.price_tiers (vendor_id, product_id, min_qty, unit_price) values (v, pr.id, pr.moq, (vals->>'price')::numeric);
      end if;
      created := created || pr.sku;
      s := jsonb_set(s, '{created}', to_jsonb((s->>'created')::int + 1));
      if jsonb_array_length(s->'created_skus') < 20 then s := jsonb_set(s, '{created_skus}', (s->'created_skus') || to_jsonb(pr.sku)); end if;
    else
      s := jsonb_set(s, '{unknown}', to_jsonb((s->>'unknown')::int + 1));
      if jsonb_array_length(s->'unknown_skus') < 20 then s := jsonb_set(s, '{unknown_skus}', (s->'unknown_skus') || to_jsonb(e->>'sku')); end if;
    end if;
  end loop;
  -- fill Committed / Available on rows the sheet just introduced
  if array_length(created, 1) > 0 and coalesce((m.config->>'write_back')::boolean, false) then
    perform private.mf_enqueue(v, 'writeback', jsonb_build_object('skus', to_jsonb(created)));
  end if;

  update public.sync_maps set last = s where id = m.id;
  perform private.mf_audit(v, actor, 'sheet_sync', coalesce(nullif(v_brand, ''), 'all') || ':' || (m.config->>'sheet'),
                           (s->>'updated') || ' updated, ' || (s->>'created') || ' created, ' || (s->>'unknown') || ' unknown');
  return s;
end $$;

/* ------------------------------------------------------------ service: write-back */

-- Claim pending write-backs, grouped per vendor, with the numbers to write.
create function public.mf_service_writeback_batch(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare out jsonb;
begin
  with picked as (
    select o.id, o.vendor_id, o.payload from private.outbox o
     where o.kind = 'writeback' and o.sent_at is null and o.attempts < 5
       and (p->>'vendor_id' is null or o.vendor_id = (p->>'vendor_id')::uuid)
     order by o.id limit 500 for update skip locked),
  bumped as (update private.outbox o set attempts = o.attempts + 1 from picked where o.id = picked.id returning picked.*),
  per_vendor as (
    select b.vendor_id, jsonb_agg(b.id) as ids,
           (select jsonb_agg(distinct upper(x)) from bumped b2, jsonb_array_elements_text(b2.payload->'skus') x where b2.vendor_id = b.vendor_id) as skus
      from bumped b group by b.vendor_id)
  select coalesce(jsonb_agg(jsonb_build_object(
      'vendor_id', pv.vendor_id, 'ids', pv.ids,
      'products', (select coalesce(jsonb_agg(jsonb_build_object('sku', pr.sku, 'brand', coalesce(b.code, ''),
                     'on_hand', pr.on_hand, 'reserved', pr.reserved, 'atp', private.mf_atp(pr.on_hand, pr.reserved, pr.safety_stock))), '[]'::jsonb)
                     from public.products pr left join public.brands b on b.id = pr.brand_id
                    where pr.vendor_id = pv.vendor_id and (pv.skus ? upper(pr.sku) or coalesce((p->>'all')::boolean, false))),
      'maps', (select coalesce(jsonb_agg(m.config || jsonb_build_object('id', m.id)), '[]'::jsonb) from public.sync_maps m
                where m.vendor_id = pv.vendor_id and coalesce((m.config->>'write_back')::boolean, false)))), '[]'::jsonb)
    into out from per_vendor pv;
  return jsonb_build_object('ok', true, 'vendors', out);
end $$;

-- Record a write-back: outbox rows done, per-map result, and what the sheet now shows.
create function public.mf_service_writeback_done(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; v uuid := (p->>'vendor_id')::uuid;
begin
  update private.outbox set sent_at = case when (p->>'ok')::boolean then now() end, error = left(coalesce(p->>'error', ''), 500)
   where id in (select (x#>>'{}')::bigint from jsonb_array_elements(coalesce(p->'ids', '[]'::jsonb)) x);
  for r in select x from jsonb_array_elements(coalesce(p->'maps', '[]'::jsonb)) x loop
    update public.sync_maps set write_back_last = jsonb_build_object('ts', now()::text, 'written', r->'written', 'error', coalesce(r->>'error', ''))
     where id = (r->>'id')::uuid and vendor_id = v;
  end loop;
  update public.products pr set sync_seen = (s->>'value')::int
    from jsonb_array_elements(coalesce(p->'seen', '[]'::jsonb)) s
   where pr.vendor_id = v and upper(pr.sku) = upper(s->>'sku');
  return jsonb_build_object('ok', true);
end $$;

-- Admin "write all stock to the sheet now": queue every product for write-back.
create function public.mf_admin_sync_write_back_all(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p, true); n int;
begin
  select count(*) into n from public.products where vendor_id = c.vendor_id;
  perform private.mf_enqueue(c.vendor_id, 'writeback',
    jsonb_build_object('skus', (select coalesce(jsonb_agg(sku), '[]'::jsonb) from public.products where vendor_id = c.vendor_id)));
  return jsonb_build_object('ok', true, 'queued', n, 'vendor_id', c.vendor_id);
end $$;

/* ------------------------------------------------------------ service: schedule & template */

-- Vendors whose automatic sync is due now; stamps the run so the next tick skips them.
create function public.mf_service_sync_due(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare out jsonb;
begin
  with due as (
    select vs.vendor_id from public.vendor_settings vs join public.vendors x on x.id = vs.vendor_id and x.active
     where exists (select 1 from public.sync_maps m where m.vendor_id = vs.vendor_id)
       and case vs.settings->>'sync_auto'
             when 'live5' then coalesce((vs.settings->>'sync_last')::timestamptz, 'epoch') < now() - interval '4 minutes'
             when 'hourly' then coalesce((vs.settings->>'sync_last')::timestamptz, 'epoch') < now() - interval '55 minutes'
             when 'daily' then coalesce((vs.settings->>'sync_last')::timestamptz, 'epoch') < now() - interval '20 hours'
                               and extract(hour from now() at time zone 'Asia/Kolkata') >= 6
             else false end),
  stamped as (
    update public.vendor_settings vs set settings = vs.settings || jsonb_build_object('sync_last', now()::text)
      from due where vs.vendor_id = due.vendor_id returning vs.vendor_id)
  select coalesce(jsonb_agg(jsonb_build_object('vendor_id', s.vendor_id, 'maps', private.mf_sync_maps_json(s.vendor_id))), '[]'::jsonb)
    into out from stamped s;
  return jsonb_build_object('ok', true, 'vendors', out);
end $$;

-- What the standard-format sheet needs: one tab per brand (and 'Stock' for the rest).
create function public.mf_service_template_data(p jsonb) returns jsonb
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
                   'atp', private.mf_atp(r.on_hand, r.reserved, r.safety_stock), 'moq', r.moq, 'lead_time', r.lead_time) order by r.sku), '[]'::jsonb)
                 from rows r));
$$;

-- Link a freshly set-up sheet: one pull map per tab, replacing pull maps for the same brands.
create function public.mf_service_template_link(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v uuid := (p->>'vendor_id')::uuid; t jsonb;
  fields jsonb := '[{"col":"Product Name","field":"name"},{"col":"HSN","field":"hsn"},{"col":"GST %","field":"gst_rate"},
                    {"col":"MRP","field":"mrp"},{"col":"Selling Price Excluding GST","field":"price"},{"col":"Stock","field":"on_hand"},
                    {"col":"MOQ","field":"moq"},{"col":"Lead Time","field":"lead_time"}]'::jsonb;
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
  -- what the sheet now shows is what we wrote: no false 'vendor edited' on the first sync
  update public.products set sync_seen = on_hand where vendor_id = v;
  perform private.mf_audit(v, coalesce(p->>'actor', 'admin'), 'sync_template', p->>'sheet', jsonb_array_length(coalesce(p->'tabs', '[]'::jsonb)) || ' tabs');
  return jsonb_build_object('ok', true, 'maps', private.mf_sync_maps_json(v));
end $$;

revoke execute on all functions in schema public, private from public, anon;
grant execute on function public.mf_admin_sync_map_save(jsonb), public.mf_admin_sync_map_delete(jsonb),
  public.mf_admin_sync_schedule(jsonb), public.mf_admin_sync_maps(jsonb), public.mf_admin_sync_write_back_all(jsonb),
  public.mf_admin_settings(jsonb) to authenticated;
grant execute on function public.mf_service_sync_apply(jsonb), public.mf_service_writeback_batch(jsonb),
  public.mf_service_writeback_done(jsonb), public.mf_service_sync_due(jsonb), public.mf_service_template_data(jsonb),
  public.mf_service_template_link(jsonb) to service_role;
revoke execute on function public.mf_service_sync_apply(jsonb), public.mf_service_writeback_batch(jsonb),
  public.mf_service_writeback_done(jsonb), public.mf_service_sync_due(jsonb), public.mf_service_template_data(jsonb),
  public.mf_service_template_link(jsonb) from authenticated;
grant execute on function public.mf_order_view(jsonb), public.mf_order_pi_respond(jsonb), public.mf_order_po_upload(jsonb) to anon, authenticated;
grant execute on function private.mf_is_platform_admin(), private.mf_is_member(uuid), private.mf_is_vendor_admin(uuid), private.mf_member_of_path(text) to authenticated;

-- Every minute: write-backs if any are waiting; sheet pulls for vendors whose schedule is due.
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_extension where extname = 'pg_net') then
    perform cron.schedule('mf-sync-tick', '* * * * *', $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'mf_functions_url') || '/sync',
        headers := jsonb_build_object('Content-Type', 'application/json',
                     'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mf_cron_secret')),
        body := '{"action":"tick"}'::jsonb)
      where exists (select 1 from private.outbox where kind = 'writeback' and sent_at is null and attempts < 5)
         or exists (select 1 from public.vendor_settings where settings->>'sync_auto' in ('live5', 'hourly', 'daily'))
    $job$);
  end if;
end $$;
