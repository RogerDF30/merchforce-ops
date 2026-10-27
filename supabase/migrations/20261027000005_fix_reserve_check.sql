-- Fix: the stock check when a PI is accepted grouped lines incorrectly
-- ("subquery uses ungrouped column"), so no reservation could be made.

create or replace function private.mf_move_stock(rid uuid, target text, actor text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  lines jsonb := private.mf_request_lines_json(rid);
  short text;
begin
  select * into r from public.requests where id = rid for update;
  if r.stock_state = target then return null; end if;

  if target = 'reserved' and r.stock_state = '' then
    -- lock first, then check: first accepted wins
    perform 1 from public.products pr
     where pr.vendor_id = r.vendor_id and upper(pr.sku) in (select upper(e->>'sku') from jsonb_array_elements(lines) e)
     order by pr.sku for update;
    with need as (
      select upper(e->>'sku') as k, min(e->>'sku') as sku, sum((e->>'qty')::int) as qty
        from jsonb_array_elements(lines) e group by 1)
    select string_agg(n.sku || ' (need ' || n.qty || ', available ' ||
                      coalesce(private.mf_atp(pr.on_hand, pr.reserved, pr.safety_stock), 0) || ')', ', ') into short
      from need n left join public.products pr on pr.vendor_id = r.vendor_id and upper(pr.sku) = n.k
     where pr.id is null or private.mf_atp(pr.on_hand, pr.reserved, pr.safety_stock) < n.qty;
    if short is not null then return 'Not enough stock to hold for this order: ' || short; end if;
    perform private.mf_adjust_stock(r.vendor_id, lines, 'reserve', 1, 'PI accepted ' || r.number, actor);
  elsif target = 'deducted' and r.stock_state = 'reserved' then
    perform private.mf_adjust_stock(r.vendor_id, lines, 'dispatch', 0, 'PO received ' || r.number, actor);
  elsif target = 'deducted' and r.stock_state = '' then
    perform private.mf_adjust_stock(r.vendor_id, lines, 'reserve', 1, 'PO received ' || r.number, actor);
    perform private.mf_adjust_stock(r.vendor_id, lines, 'dispatch', 0, 'PO received ' || r.number, actor);
  elsif target = '' and r.stock_state = 'reserved' then
    perform private.mf_adjust_stock(r.vendor_id, lines, 'reserve', -1, 'released ' || r.number, actor);
  elsif target = '' and r.stock_state = 'deducted' then
    if r.status not in ('PO Received', 'In Production') then
      return 'This order has already shipped (' || r.status || '), so its stock cannot be returned automatically. Record the return in the catalogue.';
    end if;
    perform private.mf_adjust_stock(r.vendor_id, lines, 'return', 0, 'returned ' || r.number, actor);
  end if;
  update public.requests set stock_state = target where id = rid;
  return null;
end $$;


revoke execute on all functions in schema private from public, anon;
grant execute on function private.mf_is_platform_admin(), private.mf_is_member(uuid), private.mf_is_vendor_admin(uuid) to authenticated;
