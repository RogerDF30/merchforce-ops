-- Merchforce on Supabase — stock screens and supply orders. Ports Stock.gs.
--
--   Reorder      products at or below their reorder point, with a suggested
--                quantity netting off what is on order or in production
--   Fulfilment   open orders from PO Received onward, aged against the stage SLA
--   Production   supply orders of kind 'make';  Purchases: kind 'buy'
-- Every number is measured from stock_log and the order book; nothing is
-- forecast. Receiving a supply order is the only thing here that adds stock.

create function private.mf_stage_sla(status text) returns int language sql immutable set search_path = '' as $$
  select case status when 'New' then 2 when 'Accepted' then 3 when 'PI Sent' then 5 when 'PI Accepted' then 3
                     when 'PO Received' then 7 when 'In Production' then 21 when 'Dispatched' then 10 else 7 end;
$$;

create function private.mf_lead_days(lead_time text) returns int language sql immutable set search_path = '' as $$
  select coalesce(nullif(regexp_replace(coalesce(lead_time, ''), '[^0-9.]', '', 'g'), '')::numeric, 0)::int
$$;

-- Lot a suggestion rounds up to: production batch for made goods, supplier MOQ for bought ones.
create function private.mf_lot(pr public.products) returns int language sql immutable set search_path = '' as $$
  select coalesce(nullif(case when pr.supply_mode = 'make' then pr.batch_qty else pr.supplier_moq end, 0), nullif(pr.moq, 0), 1);
$$;

-- Units per SKU that actually left over the window: deductions, less goods that came back.
create function private.mf_consumption(v uuid, days int)
returns table (k text, units int, last_out timestamptz)
language sql stable security definer set search_path = '' as $$
  select upper(l.sku),
         greatest(0, sum(case when l.ts >= now() - make_interval(days => days) then
           case when l.delta < 0 and l.reason ~* '^(PO received|dispatch)' then -l.delta
                when l.delta > 0 and l.reason ~* '^returned ' then -l.delta else 0 end else 0 end))::int,
         max(case when l.delta < 0 and l.reason ~* '^(PO received|dispatch)' then l.ts end)
    from public.stock_log l
   where l.vendor_id = v and ((l.delta < 0 and l.reason ~* '^(PO received|dispatch)') or (l.delta > 0 and l.reason ~* '^returned '))
   group by 1;
$$;

create function private.mf_inbound(v uuid) returns table (k text, qty int)
language sql stable security definer set search_path = '' as $$
  select upper(s.sku), sum(s.qty - s.received_qty)::int from public.supply_orders s
   where s.vendor_id = v and s.status in ('Planned', 'Open') and s.qty > s.received_qty group by 1;
$$;

create function private.mf_reorder_rows(v uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with base as (
    select pr.*, private.mf_atp(pr.on_hand, pr.reserved, pr.safety_stock) as atp,
           coalesce(c.units, 0)::numeric / 90 as rate, c.last_out,
           coalesce(nullif(private.mf_lead_days(pr.lead_time), 0), 14) as lead,
           private.mf_lot(pr) as lot, coalesce(i.qty, 0) as inbound
      from public.products pr
      left join private.mf_consumption(v, 90) c on c.k = upper(pr.sku)
      left join private.mf_inbound(v) i on i.k = upper(pr.sku)
     where pr.vendor_id = v),
  due as (
    select b.*, ceil(b.rate * (b.lead + 30))::int + b.safety_stock as target from base b
     where b.atp <= 0 or (b.reorder_point > 0 and b.atp <= b.reorder_point)),
  calc as (
    select d.*, d.target - d.atp - d.inbound as gap from due d)
  select coalesce(jsonb_agg(jsonb_build_object(
      'sku', x.sku, 'name', x.name, 'brand', coalesce((select b.code from public.brands b where b.id = x.brand_id), ''),
      'mode', x.supply_mode, 'vendor', x.supplier,
      'atp', x.atp, 'on_hand', x.on_hand, 'reserved', x.reserved, 'reorder_point', x.reorder_point, 'safety_stock', x.safety_stock,
      'rate_per_day', round(x.rate, 2), 'days_cover', case when x.rate > 0 then floor(x.atp / x.rate)::int end,
      'lead_days', x.lead, 'lot', x.lot, 'inbound', x.inbound, 'target', x.target,
      'suggest_qty', case when x.gap > 0 then greatest(x.lot, ceil(x.gap::numeric / x.lot)::int * x.lot)
                          when x.inbound = 0 and x.reorder_point > 0 then x.lot else 0 end,
      'covered', x.gap <= 0 and x.inbound > 0,
      'last_out', coalesce(to_char(x.last_out at time zone 'Asia/Kolkata', 'FMDD Mon YYYY'), ''))
    order by case when x.atp <= 0 then 0 else 1 end, coalesce(case when x.rate > 0 then floor(x.atp / x.rate) end, 9999), x.atp), '[]'::jsonb)
  from calc x;
$$;

create function private.mf_fulfilment_rows(v uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with q as (
    select r, floor(extract(epoch from now() - coalesce((r.status_dates->>r.status)::timestamptz, r.created_at)) / 86400)::int as age,
           private.mf_stage_sla(r.status) as sla
      from public.requests r where r.vendor_id = v and r.status in ('PO Received', 'In Production', 'Dispatched'))
  select coalesce(jsonb_agg(jsonb_build_object(
      'order', private.mf_order_out(q.r, false), 'id', (q.r).number, 'company', (q.r).company, 'status', (q.r).status,
      'po_number', (q.r).po_number, 'age_days', q.age, 'sla_days', q.sla, 'overdue', q.age > q.sla,
      'lines', (select count(*) from public.request_lines l where l.request_id = (q.r).id),
      'units', (select coalesce(sum(l.qty), 0) from public.request_lines l where l.request_id = (q.r).id),
      'shipped', (select coalesce(sum(s.qty), 0) from public.shipments s where s.request_id = (q.r).id),
      'short', coalesce((select jsonb_agg(l.sku || case when pr.id is null then ' (not in catalogue)' else ' short by ' || abs(pr.on_hand) end)
                           from public.request_lines l left join public.products pr on pr.vendor_id = v and upper(pr.sku) = upper(l.sku)
                          where l.request_id = (q.r).id and (pr.id is null or pr.on_hand < 0)), '[]'::jsonb))
    order by (q.age - q.sla) desc), '[]'::jsonb)
  from q;
$$;

create function private.mf_supply_out(s public.supply_orders) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', s.number, 'kind', s.kind, 'sku', s.sku, 'name', s.name, 'qty', s.qty,
    'vendor', s.supplier, 'status', s.status, 'expected', coalesce(s.expected::text, ''), 'ref', s.ref, 'note', s.note,
    'created_by', s.created_by, 'created', s.created_at::text, 'updated', s.updated_at::text,
    'received_qty', s.received_qty, 'received', coalesce(s.received_at::text, ''));
$$;

create function public.mf_admin_stock(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); reorder jsonb; queue jsonb; supply jsonb; s jsonb := private.mf_settings(c.vendor_id);
begin
  reorder := private.mf_reorder_rows(c.vendor_id);
  queue := private.mf_fulfilment_rows(c.vendor_id);
  supply := coalesce((select jsonb_agg(private.mf_supply_out(x) order by x.created_at desc) from public.supply_orders x where x.vendor_id = c.vendor_id), '[]'::jsonb);
  return jsonb_build_object('ok', true,
    'generated_at', to_char(now() at time zone 'Asia/Kolkata', 'FMDD Mon YYYY, FMHH12:MI am'),
    'measured_over_days', 90, 'cover_days', 30,
    'reorder', reorder, 'queue', queue, 'supply', supply,
    'products', coalesce((select jsonb_agg(jsonb_build_object('sku', pr.sku, 'name', pr.name, 'mode', pr.supply_mode,
                  'vendor', pr.supplier, 'lot', private.mf_lot(pr), 'atp', private.mf_atp(pr.on_hand, pr.reserved, pr.safety_stock),
                  'on_hand', pr.on_hand, 'lead_days', coalesce(nullif(private.mf_lead_days(pr.lead_time), 0), 14),
                  'reorder_point', pr.reorder_point, 'safety_stock', pr.safety_stock,
                  'vendor_moq', coalesce(pr.supplier_moq, 0), 'batch_qty', coalesce(pr.batch_qty, 0), 'moq', pr.moq) order by pr.sku)
                  from public.products pr where pr.vendor_id = c.vendor_id), '[]'::jsonb),
    'counts', jsonb_build_object(
      'out_of_stock', (select count(*) from jsonb_array_elements(reorder) e where (e->>'atp')::int <= 0),
      'reorder_due', jsonb_array_length(reorder),
      'covered', (select count(*) from jsonb_array_elements(reorder) e where (e->>'covered')::boolean),
      'queue', jsonb_array_length(queue),
      'overdue', (select count(*) from jsonb_array_elements(queue) e where (e->>'overdue')::boolean),
      'short_orders', (select count(*) from jsonb_array_elements(queue) e where jsonb_array_length(e->'short') > 0),
      'make_open', (select count(*) from public.supply_orders x where x.vendor_id = c.vendor_id and x.kind = 'make' and x.status in ('Planned', 'Open')),
      'buy_open', (select count(*) from public.supply_orders x where x.vendor_id = c.vendor_id and x.kind = 'buy' and x.status in ('Planned', 'Open')),
      'no_reorder_point', (select count(*) from public.products pr where pr.vendor_id = c.vendor_id and pr.reorder_point = 0),
      'supply_mode_unset', 0),
    'reorder_alert', coalesce(s->>'reorder_alert', 'off'), 'notify_email', coalesce(s->>'notify_email', ''));
end $$;

-- Per-SKU supply parameters, edited from the reorder screen.
create function public.mf_admin_supply_fields(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); v_mode text := lower(coalesce(p->>'supply_mode', ''));
begin
  if coalesce(p->>'sku', '') = '' then raise exception 'sku required'; end if;
  update public.products set
    supply_mode = case when v_mode in ('make', 'buy') then v_mode else 'buy' end,
    supplier = trim(coalesce(p->>'vendor', '')),
    supplier_moq = nullif(private.mf_num(p, 'vendor_moq')::int, 0), batch_qty = nullif(private.mf_num(p, 'batch_qty')::int, 0),
    reorder_point = private.mf_num(p, 'reorder_point')::int, safety_stock = private.mf_num(p, 'safety_stock')::int,
    lead_time = trim(coalesce(p->>'lead_time', '')), updated_at = now()
  where vendor_id = c.vendor_id and upper(sku) = upper(p->>'sku');
  if not found then raise exception 'Product not found: %', upper(p->>'sku'); end if;
  perform private.mf_audit(c.vendor_id, c.actor, 'supply_fields', upper(p->>'sku'), v_mode);
  return jsonb_build_object('ok', true, 'sku', upper(p->>'sku'));
end $$;

create function public.mf_admin_supply_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  d jsonb := coalesce(p->'supply', '{}'::jsonb);
  s public.supply_orders; pr public.products; v_kind text; q numeric; st text;
begin
  if coalesce(d->>'id', '') <> '' then
    select * into s from public.supply_orders where vendor_id = c.vendor_id and number = d->>'id' for update;
    if s.id is null then raise exception 'Supply order not found: %', d->>'id'; end if;
  else
    select * into pr from public.products x where x.vendor_id = c.vendor_id and upper(x.sku) = upper(coalesce(d->>'sku', ''));
    if pr.id is null then raise exception 'Product not found: %', upper(coalesce(d->>'sku', '')); end if;
    v_kind := case when lower(coalesce(d->>'kind', '')) in ('make', 'buy') then lower(d->>'kind') else pr.supply_mode end;
    s.kind := v_kind; s.product_id := pr.id; s.sku := pr.sku; s.name := pr.name; s.qty := 0;
    s.supplier := case when d ? 'vendor' then coalesce(d->>'vendor', '') else pr.supplier end;
    s.status := 'Planned'; s.received_qty := 0; s.ref := ''; s.note := '';
  end if;
  if d ? 'qty' then
    q := private.mf_num(d, 'qty');
    if q <= 0 then raise exception 'Quantity must be above zero'; end if;
    if q < s.received_qty then raise exception 'Quantity cannot be below what has already been received (%)', s.received_qty; end if;
    s.qty := q;
  end if;
  if coalesce(s.qty, 0) = 0 then raise exception 'Quantity required'; end if;
  if d ? 'vendor' then s.supplier := trim(coalesce(d->>'vendor', '')); end if;
  if d ? 'expected' then s.expected := nullif(trim(coalesce(d->>'expected', '')), '')::date; end if;
  if d ? 'ref' then s.ref := trim(coalesce(d->>'ref', '')); end if;
  if d ? 'note' then s.note := trim(coalesce(d->>'note', '')); end if;
  if d ? 'status' then
    st := d->>'status';
    if not (st = any (array['Planned', 'Open', 'Done', 'Cancelled'])) then raise exception 'Unknown status: %', st; end if;
    if st = 'Done' and s.received_qty <= 0 then raise exception 'Receive the goods first; Done is set when the quantity arrives'; end if;
    if s.status = 'Done' and st <> 'Done' then raise exception 'A completed supply order cannot be reopened'; end if;
    s.status := st;
  end if;
  if s.id is null then
    insert into public.supply_orders (vendor_id, number, kind, product_id, sku, name, qty, supplier, status, expected, ref, note, created_by)
    values (c.vendor_id, private.mf_next_number(c.vendor_id, 'supply', 'SO', false), s.kind, s.product_id, s.sku, s.name, s.qty,
            s.supplier, s.status, s.expected, s.ref, s.note, c.actor)
    returning * into s;
  else
    update public.supply_orders set qty = s.qty, supplier = s.supplier, expected = s.expected, ref = s.ref, note = s.note,
           status = s.status, updated_at = now() where id = s.id returning * into s;
  end if;
  perform private.mf_audit(c.vendor_id, c.actor, 'supply_save', s.number, s.kind || ' ' || s.sku || ' × ' || s.qty || ' · ' || s.status);
  return jsonb_build_object('ok', true, 'supply', private.mf_supply_out(s));
end $$;

-- Goods arrived or a run finished: adds to on hand. Partial receipts stay Open.
create function public.mf_admin_supply_receive(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); s public.supply_orders; q int := floor(private.mf_num(p, 'qty'));
begin
  if q <= 0 then raise exception 'Quantity must be above zero'; end if;
  select * into s from public.supply_orders where vendor_id = c.vendor_id and number = p->>'id' for update;
  if s.id is null then raise exception 'Supply order not found'; end if;
  if s.status not in ('Planned', 'Open') then raise exception 'This supply order is %', s.status; end if;
  if not exists (select 1 from public.products pr where pr.vendor_id = c.vendor_id and upper(pr.sku) = upper(s.sku)) then
    raise exception 'Product not found: %', s.sku;
  end if;
  perform private.mf_adjust_stock(c.vendor_id, jsonb_build_array(jsonb_build_object('sku', s.sku, 'qty', q)), 'return', 0,
          case when s.kind = 'make' then 'production done ' else 'supply received ' end || s.number, c.actor);
  update public.supply_orders set received_qty = received_qty + q, received_at = now(), updated_at = now(),
         status = case when received_qty + q >= qty or private.mf_bool(p, 'close') then 'Done' else 'Open' end
   where id = s.id returning * into s;
  perform private.mf_audit(c.vendor_id, c.actor, 'supply_receive', s.number, s.sku || ' +' || q || ' → ' || s.status);
  return jsonb_build_object('ok', true, 'supply', private.mf_supply_out(s));
end $$;

create function public.mf_admin_supply_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); s public.supply_orders;
begin
  select * into s from public.supply_orders where vendor_id = c.vendor_id and number = p->>'id';
  if s.id is null then raise exception 'Supply order not found'; end if;
  if s.received_qty > 0 then raise exception 'Stock has been received against this order; cancel it instead of deleting'; end if;
  delete from public.supply_orders where id = s.id;
  perform private.mf_audit(c.vendor_id, c.actor, 'supply_delete', s.number, s.sku || ' × ' || s.qty);
  return jsonb_build_object('ok', true);
end $$;

/* ------------------------------------------------------------ reorder digest */

create function private.mf_reorder_digest(v uuid, actor text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare rows jsonb := private.mf_reorder_rows(v); v_to text := private.mf_settings(v)->>'notify_email'; body text;
begin
  if coalesce(v_to, '') = '' then return jsonb_build_object('sent', false, 'reason', 'notify_email is not set in Settings'); end if;
  if jsonb_array_length(rows) = 0 then return jsonb_build_object('sent', false, 'reason', 'Nothing at or below the reorder point'); end if;
  select string_agg(r->>'sku' || '  ' || (r->>'name') || E'\n    ATP ' || (r->>'atp') ||
           case when (r->>'reorder_point')::int > 0 then ' (point ' || (r->>'reorder_point') || ')' else ' (out of stock)' end ||
           case when r->>'days_cover' is not null then ' · ' || (r->>'days_cover') || ' days cover' else ' · no recent dispatches' end ||
           case when (r->>'inbound')::int > 0 then ' · ' || (r->>'inbound') || ' on order' else '' end ||
           case when (r->>'covered')::boolean then ' · covered by inbound'
                else ' · suggest ' || (r->>'suggest_qty') || ' (' || case when r->>'mode' = 'make' then 'produce' else 'buy' end || ')' end,
         E'\n\n') into body
    from jsonb_array_elements(rows) r;
  perform private.mf_mail(v, v_to, '[' || private.mf_biz(v) || '] Reorder due',
    jsonb_array_length(rows) || ' product' || case when jsonb_array_length(rows) = 1 then '' else 's' end ||
    ' at or below the reorder point as of ' || to_char(now() at time zone 'Asia/Kolkata', 'FMDD Mon YYYY, FMHH12:MI am') ||
    E'.\n\n' || body || E'\n\nOpen the Stock tab in the console to plan a run or a purchase.');
  perform private.mf_audit(v, actor, 'reorder_digest', '', v_to);
  return jsonb_build_object('sent', true, 'to', v_to, 'via', 'queued');
end $$;

create function public.mf_admin_stock_alert(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  return jsonb_build_object('ok', true) || private.mf_reorder_digest(c.vendor_id, c.actor);
end $$;

-- 'daily' is honoured by the scheduled job below; no per-vendor trigger to manage.
create function public.mf_admin_stock_schedule(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); v_mode text := case when p->>'mode' = 'daily' then 'daily' else 'off' end;
begin
  insert into public.vendor_settings (vendor_id, settings) values (c.vendor_id, jsonb_build_object('reorder_alert', v_mode))
  on conflict (vendor_id) do update set settings = public.vendor_settings.settings || excluded.settings, updated_at = now();
  perform private.mf_audit(c.vendor_id, c.actor, 'reorder_schedule', '', v_mode);
  return jsonb_build_object('ok', true, 'mode', v_mode);
end $$;

-- Every vendor that asked for it, once a day at 08:00 IST.
create function private.mf_reorder_digests_all() returns void
language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  for v in select vs.vendor_id from public.vendor_settings vs join public.vendors x on x.id = vs.vendor_id
            where x.active and vs.settings->>'reorder_alert' = 'daily' loop
    perform private.mf_reorder_digest(v.vendor_id, 'system');
  end loop;
end $$;

do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('mf-reorder-digest', '30 2 * * *', 'select private.mf_reorder_digests_all()');
  end if;
end $$;

revoke execute on all functions in schema public, private from public, anon;
grant execute on function
  public.mf_admin_stock(jsonb), public.mf_admin_supply_fields(jsonb), public.mf_admin_supply_save(jsonb),
  public.mf_admin_supply_receive(jsonb), public.mf_admin_supply_delete(jsonb),
  public.mf_admin_stock_alert(jsonb), public.mf_admin_stock_schedule(jsonb)
to authenticated;
grant execute on function public.mf_order_view(jsonb), public.mf_order_pi_respond(jsonb), public.mf_order_po_upload(jsonb) to anon, authenticated;
grant execute on function private.mf_is_platform_admin(), private.mf_is_member(uuid), private.mf_is_vendor_admin(uuid), private.mf_member_of_path(text) to authenticated;
