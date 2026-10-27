-- Merchforce on Supabase — customer returns. Ports Returns.gs.
--
-- Staff log a return against an order that has shipped. It moves
--   Requested → Approved → Received → Closed   (or Rejected before receipt)
-- Receiving is the inspection: each unit is restocked (back on hand, StockLog
-- 'returned …', which also takes it out of consumption) or scrapped. Closing
-- needs a resolution: credit note, refund, replacement (a linked zero-value
-- order at PO Received that deducts stock and ships like any other) or none.

create function private.mf_return_reasons() returns text[] language sql immutable set search_path = '' as $$
  select array['Refused at delivery', 'Damaged', 'Wrong item', 'Quality issue', 'Excess / not needed', 'Other'];
$$;
create function private.mf_resolutions() returns text[] language sql immutable set search_path = '' as $$
  select array['Credit note', 'Refund', 'Replacement', 'None'];
$$;

create function private.mf_return_out(x public.returns) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', x.number, 'request_id', (select r.number from public.requests r where r.id = x.request_id),
    'company', x.company, 'status', x.status, 'reason', x.reason, 'note', x.note,
    'carrier', x.carrier, 'tracking', x.tracking, 'resolution', x.resolution,
    'amount', coalesce(x.amount, 0), 'ref', x.ref, 'doc_path', x.doc_path, 'doc_url', '',
    'replacement_id', coalesce((select r.number from public.requests r where r.id = x.replacement_id), ''),
    'status_dates', x.status_dates, 'created_by', x.created_by, 'created', x.created_at::text,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('sku', l.sku, 'name', l.name, 'qty', l.qty,
                         'restocked', l.restocked, 'scrapped', l.scrapped) order by l.line)
                       from public.return_lines l where l.return_id = x.id), '[]'::jsonb));
$$;

create function private.mf_return_status(rid uuid, st text, actor text) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.returns;
begin
  update public.returns set status = st, status_dates = status_dates || jsonb_build_object(st, now()::text), updated_at = now()
   where id = rid returning * into x;
  perform private.mf_audit(x.vendor_id, actor, 'return_status', x.number, st);
end $$;

create function public.mf_admin_returns(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  return jsonb_build_object('ok', true,
    'returns', coalesce((select jsonb_agg(private.mf_return_out(x) order by x.created_at desc, x.number desc)
                         from public.returns x join public.requests r on r.id = x.request_id
                        where x.vendor_id = c.vendor_id and (coalesce(p->>'request_id', '') = '' or r.number = p->>'request_id')), '[]'::jsonb),
    'reasons', to_jsonb(private.mf_return_reasons()), 'resolutions', to_jsonb(private.mf_resolutions()));
end $$;

-- Log a return. Lines are capped at what was ordered, less what is already coming back.
create function public.mf_admin_return_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  r public.requests; ln jsonb; v_qty int; v_left int; v_ordered int; v_name text;
  clean jsonb := '[]'::jsonb; v_id uuid; v_num text; i int := 0;
begin
  select * into r from public.requests where vendor_id = c.vendor_id and number = p->>'request_id' for update;
  if r.id is null then raise exception 'Order not found'; end if;
  if r.status not in ('Dispatched', 'Delivered', 'Closed') then
    raise exception 'Only an order that has shipped can take a return (this one is %)', r.status;
  end if;
  if not (coalesce(p->>'reason', '') = any (private.mf_return_reasons())) then raise exception 'Choose a reason'; end if;

  for ln in select e from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) e loop
    v_qty := floor(private.mf_num(ln, 'qty'));
    continue when v_qty = 0;
    select sum(l.qty), min(l.name) into v_ordered, v_name from public.request_lines l
     where l.request_id = r.id and upper(l.sku) = upper(ln->>'sku');
    if v_ordered is null then raise exception '% is not on this order', ln->>'sku'; end if;
    select v_ordered - coalesce(sum(rl.qty), 0) into v_left
      from public.return_lines rl join public.returns x on x.id = rl.return_id
     where x.request_id = r.id and x.status <> 'Rejected' and upper(rl.sku) = upper(ln->>'sku');
    if v_qty < 0 or v_qty > v_left then raise exception '%: at most % can be returned', v_name, v_left; end if;
    clean := clean || jsonb_build_object('sku', ln->>'sku', 'name', v_name, 'qty', v_qty);
  end loop;
  if jsonb_array_length(clean) = 0 then raise exception 'Enter a quantity for at least one line'; end if;

  v_num := private.mf_next_number(c.vendor_id, 'rma', 'RMA', false);
  insert into public.returns (vendor_id, number, request_id, company, status, reason, note, status_dates, created_by)
  values (c.vendor_id, v_num, r.id, r.company, 'Requested', p->>'reason', left(coalesce(p->>'note', ''), 1000),
          jsonb_build_object('Requested', now()::text), c.actor)
  returning id into v_id;
  for ln in select e from jsonb_array_elements(clean) e loop
    i := i + 1;
    insert into public.return_lines (vendor_id, return_id, line, sku, name, qty)
    values (c.vendor_id, v_id, i, ln->>'sku', ln->>'name', (ln->>'qty')::int);
  end loop;
  perform private.mf_audit(c.vendor_id, c.actor, 'return_new', v_num, r.number || ' · ' || (p->>'reason'));
  return jsonb_build_object('ok', true, 'id', v_num);
end $$;

-- Approve or reject, and keep carrier / tracking / note current.
create function public.mf_admin_return_update(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); x public.returns; allowed text[];
begin
  select * into x from public.returns where vendor_id = c.vendor_id and number = p->>'id' for update;
  if x.id is null then raise exception 'Return not found'; end if;
  if x.status in ('Closed', 'Rejected') then raise exception 'This return is %', x.status; end if;
  update public.returns set
    carrier = case when p ? 'carrier' then left(coalesce(p->>'carrier', ''), 120) else carrier end,
    tracking = case when p ? 'tracking' then left(coalesce(p->>'tracking', ''), 120) else tracking end,
    note = case when p ? 'note' then left(coalesce(p->>'note', ''), 1000) else note end,
    updated_at = now()
  where id = x.id;
  if coalesce(p->>'status', '') <> '' and p->>'status' <> x.status then
    allowed := case x.status when 'Requested' then array['Approved', 'Rejected'] when 'Approved' then array['Rejected'] else array[]::text[] end;
    if not (p->>'status' = any (allowed)) then raise exception 'A % return cannot move to %', x.status, p->>'status'; end if;
    perform private.mf_return_status(x.id, p->>'status', c.actor);
  end if;
  return jsonb_build_object('ok', true, 'id', x.number, 'status', (select status from public.returns where id = x.id));
end $$;

-- Goods are back: every unit restocked or scrapped; restocked units go back on hand.
create function public.mf_admin_return_receive(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  x public.returns; l public.return_lines; g jsonb; v_rs int; v_sc int;
  restock jsonb := '[]'::jsonb; v_order text;
begin
  select * into x from public.returns where vendor_id = c.vendor_id and number = p->>'id' for update;
  if x.id is null then raise exception 'Return not found'; end if;
  if x.status <> 'Approved' then raise exception 'Approve the return before receiving it (it is %)', x.status; end if;
  for l in select * from public.return_lines where return_id = x.id order by line loop
    select e into g from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) e where upper(e->>'sku') = upper(l.sku) limit 1;
    v_rs := floor(private.mf_num(coalesce(g, '{}'::jsonb), 'restocked'));
    v_sc := floor(private.mf_num(coalesce(g, '{}'::jsonb), 'scrapped'));
    if v_rs < 0 or v_sc < 0 or v_rs + v_sc <> l.qty then
      raise exception '%: restocked + scrapped must equal the % returned', l.name, l.qty;
    end if;
    update public.return_lines set restocked = v_rs, scrapped = v_sc where id = l.id;
    if v_rs > 0 then restock := restock || jsonb_build_object('sku', l.sku, 'qty', v_rs); end if;
  end loop;
  select r.number into v_order from public.requests r where r.id = x.request_id;
  if jsonb_array_length(restock) > 0 then
    perform private.mf_adjust_stock(c.vendor_id, restock, 'return', 0, 'returned ' || x.number || ' (' || v_order || ')', c.actor);
  end if;
  perform private.mf_return_status(x.id, 'Received', c.actor);
  return jsonb_build_object('ok', true, 'id', x.number, 'status', 'Received', 'restocked', restock);
end $$;

-- A replacement: a new zero-value order for the returned quantities, started at
-- PO Received so it deducts stock and ships through the normal shipment flow.
create function private.mf_replacement_order(x public.returns, actor text, actor_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.requests; v_rid uuid; v_num text; e text; short text;
begin
  select * into o from public.requests where id = x.request_id;
  -- a PO deducts without a stock check, so check here: refuse rather than go negative
  perform 1 from public.products pr
   where pr.vendor_id = x.vendor_id and upper(pr.sku) in (select upper(rl.sku) from public.return_lines rl where rl.return_id = x.id)
   order by pr.sku for update;
  select string_agg(rl.sku || ' (need ' || rl.qty || ', available ' ||
                    coalesce(private.mf_atp(pr.on_hand, pr.reserved, pr.safety_stock), 0) || ')', ', ') into short
    from public.return_lines rl left join public.products pr on pr.vendor_id = x.vendor_id and upper(pr.sku) = upper(rl.sku)
   where rl.return_id = x.id and (pr.id is null or private.mf_atp(pr.on_hand, pr.reserved, pr.safety_stock) < rl.qty);
  if short is not null then raise exception 'Not enough stock for a replacement: %', short; end if;
  v_num := private.mf_next_number(x.vendor_id, 'request', 'MF', true);
  insert into public.requests (vendor_id, number, status, status_dates, company, contact, email, phone, gstin, notes,
                               total_est, token, ship_address, place_of_supply, company_id, raised_by, assigned_to, assigned_name)
  values (x.vendor_id, v_num, 'New', jsonb_build_object('New', now()::text), o.company, o.contact, o.email, o.phone, o.gstin,
          'Replacement for ' || x.number || ' (order ' || o.number || ')', 0, private.mf_token(), o.ship_address,
          o.place_of_supply, o.company_id, actor, o.assigned_to, o.assigned_name)
  returning id into v_rid;
  insert into public.request_lines (vendor_id, request_id, line, sku, name, qty, unit_price, line_total, list_price, gst, hsn)
  select x.vendor_id, v_rid, rl.line, rl.sku, rl.name, rl.qty, 0, 0,
         (select ol.unit_price from public.request_lines ol where ol.request_id = o.id and upper(ol.sku) = upper(rl.sku) limit 1),
         coalesce((select ol.gst from public.request_lines ol where ol.request_id = o.id and upper(ol.sku) = upper(rl.sku) limit 1), 0),
         coalesce((select ol.hsn from public.request_lines ol where ol.request_id = o.id and upper(ol.sku) = upper(rl.sku) limit 1), '')
    from public.return_lines rl where rl.return_id = x.id;
  e := private.mf_set_status(v_rid, 'PO Received', actor, 'replacement for ' || x.number);
  if e is not null then
    raise exception '%', replace(e, 'Not enough stock to hold for this order', 'Not enough stock for a replacement');
  end if;
  perform private.mf_audit(x.vendor_id, actor, 'return_replacement', x.number, v_num);
  return v_rid;
end $$;

-- Settle with the customer and close. Credit note / refund need an amount.
create function public.mf_admin_return_close(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  x public.returns; v_res text := coalesce(p->>'resolution', ''); v_rep uuid; v_path text := ''; v_order text;
begin
  select * into x from public.returns where vendor_id = c.vendor_id and number = p->>'id' for update;
  if x.id is null then raise exception 'Return not found'; end if;
  if x.status <> 'Received' then raise exception 'Receive the goods before closing (it is %)', x.status; end if;
  if not (v_res = any (private.mf_resolutions())) then raise exception 'Choose how the return is resolved'; end if;
  if v_res in ('Credit note', 'Refund') and not (private.mf_num(p, 'amount') > 0) then
    raise exception 'Enter the % amount', lower(v_res);
  end if;
  if v_res = 'Replacement' then v_rep := private.mf_replacement_order(x, c.actor, c.user_id); end if;
  select r.number into v_order from public.requests r where r.id = x.request_id;
  if coalesce(p->>'path', '') like c.vendor_id::text || '/%' then v_path := p->>'path';
  elsif coalesce(p->>'filename', '') <> '' then
    v_path := c.vendor_id::text || '/orders/' || v_order || '/' || x.number || '-' || regexp_replace(p->>'filename', '[^A-Za-z0-9._-]', '_', 'g');
  end if;
  update public.returns set resolution = v_res,
    amount = case when v_res in ('Credit note', 'Refund') then private.mf_num(p, 'amount') end,
    ref = left(coalesce(p->>'ref', ''), 80), doc_path = v_path, replacement_id = v_rep
  where id = x.id;
  perform private.mf_return_status(x.id, 'Closed', c.actor);
  return jsonb_build_object('ok', true, 'id', x.number, 'status', 'Closed', 'doc_path', v_path,
    'replacement_id', coalesce((select r.number from public.requests r where r.id = v_rep), ''));
end $$;

revoke execute on all functions in schema public, private from public, anon;
grant execute on function
  public.mf_admin_returns(jsonb), public.mf_admin_return_create(jsonb), public.mf_admin_return_update(jsonb),
  public.mf_admin_return_receive(jsonb), public.mf_admin_return_close(jsonb)
to authenticated;
grant execute on function public.mf_order_view(jsonb), public.mf_order_pi_respond(jsonb), public.mf_order_po_upload(jsonb) to anon, authenticated;
grant execute on function private.mf_is_platform_admin(), private.mf_is_member(uuid), private.mf_is_vendor_admin(uuid) to authenticated;
