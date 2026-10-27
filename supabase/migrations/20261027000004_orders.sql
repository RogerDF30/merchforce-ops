-- Merchforce on Supabase — enquiries, orders, stock discipline, shipments and
-- the customer's own order page. Ports Requests.gs + Orders.gs.
--
-- Stock discipline (the point of the whole flow):
--   PI Accepted  → RESERVE  (available-to-promise drops; held for this buyer)
--   PO Received  → DEDUCT   (on hand actually reduces)
--   Rejected / Declined / Expired / Cancelled → release a reservation, or
--     return deducted goods while still in house (PO Received, In Production);
--     refused once shipped.
-- requests.stock_state ('', 'reserved', 'deducted') is the source of truth, so
-- a status set by hand can never double-reserve or double-deduct. Product rows
-- are locked in SKU order for the length of the transaction: two people
-- accepting the last units at once cannot both succeed.

-- Freight, discount and notes the PI was built with, for re-rendering the PDF.
alter table public.requests add column pi_extras jsonb not null default '{}'::jsonb;

/* ------------------------------------------------------------ constants & formatting */

create function private.mf_statuses() returns text[] language sql immutable set search_path = '' as $$
  select array['New', 'Accepted', 'PI Sent', 'PI Accepted', 'PO Received', 'In Production', 'Dispatched', 'Delivered', 'Closed'];
$$;
create function private.mf_terminal() returns text[] language sql immutable set search_path = '' as $$
  select array['Rejected', 'Declined', 'Expired', 'Cancelled'];
$$;
create function private.mf_active_end() returns text[] language sql immutable set search_path = '' as $$
  select array['Delivered', 'Closed'];
$$;

-- ₹ amounts the Indian way: 12,34,567.50
create function private.mf_money(n numeric) returns text
language plpgsql immutable set search_path = '' as $$
declare s text := to_char(round(abs(coalesce(n, 0)), 2), 'FM9999999999990.00'); i text; f text; out text;
begin
  i := split_part(s, '.', 1); f := split_part(s, '.', 2);
  if length(i) > 3 then
    out := right(i, 3); i := left(i, length(i) - 3);
    while length(i) > 2 loop out := right(i, 2) || ',' || out; i := left(i, length(i) - 2); end loop;
    out := i || ',' || out;
  else out := i; end if;
  return case when n < 0 then '-' else '' end || out || '.' || f;
end $$;

create function private.mf_order_link(v uuid, token text) returns text
language sql stable security definer set search_path = '' as $$
  select case when coalesce(private.mf_settings(v)->>'site_url', '') = '' then ''
              else rtrim(private.mf_settings(v)->>'site_url', '/') || '/order.html?t=' || token end;
$$;

create function private.mf_biz(v uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(trim(s->>'co_name'), ''), nullif(trim(s->>'site_name'), ''), 'Merchforce')
    from (select private.mf_settings(v) as s) x;
$$;
create function private.mf_site(v uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(private.mf_settings(v)->>'site_name', ''), 'Merchforce');
$$;

/* ------------------------------------------------------------ lookups & payload */

create function private.mf_request_id(v uuid, num text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.requests where vendor_id = v and number = num;
$$;

create function private.mf_lines_text(rid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(string_agg('  ' || l.sku || '  ' || l.name || '  ×' || l.qty || '  @ ₹' || private.mf_money(l.unit_price), E'\n' order by l.line), '')
    from public.request_lines l where l.request_id = rid;
$$;

-- The order as the console (for_client = false) or the customer (true) sees it.
create function private.mf_order_out(r public.requests, for_client boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.number, 'created', r.created_at::text, 'status', r.status, 'status_dates', r.status_dates,
    'company', r.company, 'contact', r.contact, 'email', r.email, 'phone', r.phone, 'gstin', r.gstin,
    'notes', r.notes, 'ship_address', r.ship_address, 'total_est', r.total_est,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('sku', l.sku, 'name', l.name, 'qty', l.qty,
                 'unit_price', l.unit_price, 'line_total', l.line_total, 'list_price', l.list_price,
                 'gst', l.gst, 'hsn', l.hsn) order by l.line)
               from public.request_lines l where l.request_id = r.id), '[]'::jsonb),
    'pi_number', r.pi_number, 'pi_path', r.pi_path, 'pi_url', '', 'pi_total', coalesce(r.pi_total, 0),
    'pi_valid_till', r.pi_valid_till, 'po_number', r.po_number, 'po_path', r.po_path, 'po_url', '',
    'shipments', coalesce((select jsonb_agg(jsonb_build_object('no', s.shipment_no, 'date', s.ship_date::text,
                 'carrier', s.carrier, 'tracking', s.tracking, 'qty', s.qty, 'note', s.note, 'status', s.status,
                 'delivered_on', coalesce(s.delivered_on::text, '')) order by s.shipment_no)
               from public.shipments s where s.request_id = r.id), '[]'::jsonb),
    'active', not (r.status = any (private.mf_active_end() || private.mf_terminal())))
  || case when for_client then '{}'::jsonb else jsonb_build_object(
    'admin_notes', r.admin_notes, 'stock_state', r.stock_state, 'token', r.token, 'folder_id', '',
    'place_of_supply', r.place_of_supply,
    'company_id', coalesce((select co.code from public.companies co where co.id = r.company_id), ''),
    'raised_by', r.raised_by,
    'assigned_to', coalesce((select lower(m.email) from public.vendor_members m where m.vendor_id = r.vendor_id and m.user_id = r.assigned_to), ''),
    'assigned_name', r.assigned_name) end;
$$;

/* ------------------------------------------------------------ stock */

-- mode: 'reserve' (dir +1/-1 on reserved), 'dispatch' (on hand and reserved down),
-- 'return' (on hand up). lines: [{sku, qty}]. Rows locked in SKU order.
create function private.mf_adjust_stock(v uuid, lines jsonb, mode text, dir int, reason text, actor text) returns void
language plpgsql security definer set search_path = '' as $$
declare l record; moved text[] := '{}';
begin
  for l in
    select pr.id, pr.sku, x.qty
      from (select upper(e->>'sku') as k, sum((e->>'qty')::int) as qty from jsonb_array_elements(lines) e group by 1) x
      join public.products pr on pr.vendor_id = v and upper(pr.sku) = x.k
     order by pr.sku
       for update of pr
  loop
    if mode = 'dispatch' then
      update public.products set on_hand = on_hand - l.qty, reserved = greatest(0, reserved - l.qty), updated_at = now() where id = l.id;
      insert into public.stock_log (vendor_id, sku, delta, reason, actor) values (v, l.sku, -l.qty, reason, actor);
    elsif mode = 'return' then
      update public.products set on_hand = on_hand + l.qty, updated_at = now() where id = l.id;
      insert into public.stock_log (vendor_id, sku, delta, reason, actor) values (v, l.sku, l.qty, reason, actor);
    else
      update public.products set reserved = greatest(0, reserved + dir * l.qty), updated_at = now() where id = l.id;
      insert into public.stock_log (vendor_id, sku, delta, reason, actor)
      values (v, l.sku, 0, reason || ' (reserved ' || case when dir > 0 then '+' else '-' end || l.qty || ')', actor);
    end if;
    moved := moved || l.sku;
  end loop;
  -- the vendor's sheet follows every movement, holds included (Committed / Available)
  if array_length(moved, 1) > 0 then
    perform private.mf_enqueue(v, 'writeback', jsonb_build_object('skus', to_jsonb(moved)));
  end if;
end $$;

create function private.mf_request_lines_json(rid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('sku', l.sku, 'qty', l.qty)), '[]'::jsonb)
    from public.request_lines l where l.request_id = rid;
$$;

-- Apply the stock transition for a request. Returns null, or why it cannot.
create function private.mf_move_stock(rid uuid, target text, actor text) returns text
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
    select string_agg(x.sku || ' (need ' || x.need || ', available ' || coalesce(x.atp, 0) || ')', ', ') into short
      from (select e->>'sku' as sku, sum((e->>'qty')::int) as need,
                   (select private.mf_atp(pr.on_hand, pr.reserved, pr.safety_stock) from public.products pr
                     where pr.vendor_id = r.vendor_id and upper(pr.sku) = upper(e->>'sku')) as atp
              from jsonb_array_elements(lines) e group by e->>'sku') x
     where x.atp is null or x.atp < x.need;
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

-- The one place every status change goes through. Returns null, or why it cannot.
create function private.mf_set_status(rid uuid, status text, actor text, note text default '') returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
  want text;
  e text;
begin
  select * into r from public.requests where id = rid for update;
  if r.status = status then return null; end if;
  if not (status = any (private.mf_statuses() || private.mf_terminal())) then return 'Unknown status'; end if;
  want := case when status = 'PI Accepted' then 'reserved'
               when status in ('PO Received', 'In Production', 'Dispatched', 'Delivered', 'Closed') then 'deducted'
               when status = any (private.mf_terminal()) then ''
               else null end;                                 -- New / Accepted / PI Sent: leave stock alone
  if want is not null then
    e := private.mf_move_stock(rid, want, actor);
    if e is not null then return e; end if;
  end if;
  update public.requests
     set status = mf_set_status.status, status_dates = status_dates || jsonb_build_object(mf_set_status.status, now()::text), updated_at = now()
   where id = rid;
  perform private.mf_audit(r.vendor_id, actor, 'order_status', r.number,
                           r.status || ' → ' || status || case when coalesce(note, '') <> '' then ' · ' || note else '' end);
  return null;
end $$;

/* ------------------------------------------------------------ notifications */

create function private.mf_notify_pi_sent(rid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.requests; link text;
begin
  select * into r from public.requests where id = rid;
  link := private.mf_order_link(r.vendor_id, r.token);
  perform private.mf_mail(r.vendor_id, r.email,
    '[' || private.mf_site(r.vendor_id) || '] Proforma invoice ' || r.pi_number || ' for ' || r.number,
    'Hello ' || r.contact || E',\n\nYour proforma invoice for ' || r.number || E' is ready.\n\n' ||
    'PI number: ' || r.pi_number || E'\nTotal: ₹' || private.mf_money(r.pi_total) || E'\n' ||
    case when r.pi_valid_till <> '' then 'Valid till: ' || r.pi_valid_till || E'\n' else '' end || E'\n' ||
    private.mf_lines_text(rid) || E'\n\n' ||
    case when link <> '' then E'Download the PI, accept or decline it, or send us your purchase order here:\n' || link || E'\n\n' else '' end ||
    E'Stock is held for you only once the proforma is accepted.\n\n' || private.mf_biz(r.vendor_id),
    private.mf_settings(r.vendor_id)->>'notify_email');
end $$;

create function private.mf_notify_po(rid uuid, who text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.requests; link text; sup text;
begin
  select * into r from public.requests where id = rid;
  sup := private.mf_settings(r.vendor_id)->>'notify_email';
  perform private.mf_mail(r.vendor_id, sup,
    '[' || private.mf_site(r.vendor_id) || '] ' || r.number || ' — purchase order received',
    case when who = 'client' then r.company || ' has uploaded their purchase order.' else 'A purchase order was added for ' || r.company || '.' end ||
    E'\n\n' || case when r.po_number <> '' then 'PO number: ' || r.po_number || E'\n' else '' end ||
    E'\nStock has been deducted for this order. It is now in production.\n', r.email);
  link := private.mf_order_link(r.vendor_id, r.token);
  perform private.mf_mail(r.vendor_id, r.email,
    '[' || private.mf_site(r.vendor_id) || '] Order confirmed — ' || r.number,
    'Hello ' || r.contact || E',\n\nWe have your purchase order' || case when r.po_number <> '' then ' (' || r.po_number || ')' else '' end ||
    E' and your order is confirmed.\n\nWe will send tracking details as the goods ship.\n' ||
    case when link <> '' then E'\nTrack it any time: ' || link || E'\n' else '' end || E'\n' || private.mf_biz(r.vendor_id), sup);
end $$;

/* ------------------------------------------------------------ enquiries */

-- Staff raise an enquiry for a customer. MOQ and visibility are checked, the
-- tier price for the quantity is applied. Stock is not held until the PI is accepted.
create function public.mf_admin_request_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  ln jsonb; pr public.products; v_qty int; v_price numeric; v_total numeric := 0;
  clean jsonb := '[]'::jsonb;
  v_num text; v_rid uuid; v_assignee uuid; v_assignee_name text; v_co uuid;
  i int := 0;
begin
  if coalesce(p->>'company', '') = '' or coalesce(p->>'contact', '') = '' or coalesce(p->>'email', '') = '' then
    raise exception 'Company, contact and email are required';
  end if;
  if not private.mf_valid_email(p->>'email') then raise exception 'Invalid email'; end if;
  if jsonb_array_length(coalesce(p->'lines', '[]'::jsonb)) = 0 then raise exception 'Cart is empty'; end if;

  for ln in select e from jsonb_array_elements(p->'lines') e limit 40 loop
    select * into pr from public.products x where x.vendor_id = c.vendor_id and upper(x.sku) = upper(ln->>'sku');
    if pr.id is null or not pr.visible then raise exception 'Unknown product: %', ln->>'sku'; end if;
    v_qty := floor(private.mf_num(ln, 'qty'));
    if v_qty < pr.moq then raise exception '%: minimum order is %', pr.name, pr.moq; end if;
    select coalesce((select t.unit_price from public.price_tiers t where t.product_id = pr.id and t.min_qty <= v_qty
                      order by t.min_qty desc limit 1), 0) into v_price;
    clean := clean || jsonb_build_object('sku', pr.sku, 'name', pr.name, 'qty', v_qty, 'price', v_price,
                                         'total', v_qty * v_price, 'gst', pr.gst_rate, 'hsn', pr.hsn);
    v_total := v_total + v_qty * v_price;
  end loop;

  if coalesce(p->>'assigned_to', '') <> '' then
    select m.user_id, coalesce(nullif(m.name, ''), m.email) into v_assignee, v_assignee_name
      from public.vendor_members m where m.vendor_id = c.vendor_id and lower(m.email) = lower(trim(p->>'assigned_to'));
  else
    v_assignee := c.user_id; v_assignee_name := c.actor;    -- follow-up owner: whoever raised it
  end if;
  if coalesce(p->>'company_id', '') <> '' then v_co := private.mf_company_id(c.vendor_id, p->>'company_id'); end if;

  v_num := private.mf_next_number(c.vendor_id, 'request', 'MF', true);
  insert into public.requests (vendor_id, number, status, status_dates, company, contact, email, phone, gstin, notes,
                               total_est, token, ship_address, place_of_supply, company_id, raised_by, assigned_to, assigned_name)
  values (c.vendor_id, v_num, 'New', jsonb_build_object('New', now()::text), left(p->>'company', 200), left(p->>'contact', 100),
          left(p->>'email', 150), left(coalesce(p->>'phone', ''), 30), left(coalesce(p->>'gstin', ''), 20),
          left(coalesce(p->>'notes', ''), 1000), v_total, private.mf_token(), left(coalesce(p->>'ship_address', ''), 500),
          left(coalesce(p->>'place_of_supply', ''), 2), v_co, c.actor, v_assignee, coalesce(v_assignee_name, ''))
  returning id into v_rid;
  for ln in select e from jsonb_array_elements(clean) e loop
    i := i + 1;
    insert into public.request_lines (vendor_id, request_id, line, sku, name, qty, unit_price, line_total, list_price, gst, hsn)
    values (c.vendor_id, v_rid, i, ln->>'sku', ln->>'name', (ln->>'qty')::int, (ln->>'price')::numeric,
            (ln->>'total')::numeric, (ln->>'price')::numeric, (ln->>'gst')::numeric, ln->>'hsn');
  end loop;

  perform private.mf_audit(c.vendor_id, c.actor, 'request_new', v_num, i || ' lines, est ' || v_total);
  perform private.mf_mail(c.vendor_id, private.mf_settings(c.vendor_id)->>'notify_email',
    '[' || private.mf_site(c.vendor_id) || '] New enquiry ' || v_num || ' — ' || (p->>'company'),
    'New request ' || v_num || ' from ' || (p->>'company') || ' (' || (p->>'contact') || ', ' || (p->>'email') ||
    case when coalesce(p->>'phone', '') <> '' then ', ' || (p->>'phone') else '' end || E')\nRaised in the console by ' || c.actor ||
    E'\n\n' || private.mf_lines_text(v_rid) || E'\n\nEstimated total: ₹' || private.mf_money(v_total) ||
    E'\nNotes: ' || coalesce(nullif(p->>'notes', ''), '-') || E'\n\nOpen the console to review.', p->>'email');
  return jsonb_build_object('ok', true, 'request_id', v_num, 'total_est', v_total);
end $$;

create function public.mf_admin_request_assign(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  r public.requests; v_user uuid; v_name text := ''; v_email text := lower(trim(coalesce(p->>'assigned_to', '')));
  was uuid;
begin
  select * into r from public.requests where vendor_id = c.vendor_id and number = p->>'id' for update;
  if r.id is null then raise exception 'Enquiry not found'; end if;
  if v_email <> '' then
    select m.user_id, coalesce(nullif(m.name, ''), m.email) into v_user, v_name
      from public.vendor_members m where m.vendor_id = c.vendor_id and lower(m.email) = v_email and m.active;
    if v_user is null then raise exception 'No active staff account with that email'; end if;
  end if;
  was := r.assigned_to;
  update public.requests set assigned_to = v_user, assigned_name = v_name, updated_at = now() where id = r.id;
  perform private.mf_audit(c.vendor_id, c.actor, 'request_assign', r.number, coalesce(was::text, 'nobody') || ' → ' || coalesce(nullif(v_email, ''), 'nobody'));
  if v_user is not null and v_user is distinct from was and v_user <> c.user_id then
    perform private.mf_mail(c.vendor_id, v_email,
      '[' || private.mf_biz(c.vendor_id) || '] ' || r.number || ' assigned to you',
      c.actor || ' assigned enquiry ' || r.number || ' (' || r.company || ' · ' || r.status || E') to you for follow-up.\n\n' ||
      'Open ' || coalesce(nullif(private.mf_settings(c.vendor_id)->>'app_name', ''), 'Merchforce') || ' and look under My enquiries.');
  end if;
  return jsonb_build_object('ok', true, 'id', r.number, 'assigned_to', v_email, 'assigned_name', v_name);
end $$;

-- Accept or reject a fresh enquiry, before any PI exists.
create function public.mf_admin_request_decide(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  rid uuid := private.mf_request_id(c.vendor_id, p->>'id');
  v_accept boolean := private.mf_bool(p, 'accept');
  e text; r public.requests; link text;
begin
  if rid is null then raise exception 'Request not found'; end if;
  e := private.mf_set_status(rid, case when v_accept then 'Accepted' else 'Rejected' end, c.actor, p->>'note');
  if e is not null then raise exception '%', e; end if;
  select * into r from public.requests where id = rid;
  link := private.mf_order_link(c.vendor_id, r.token);
  perform private.mf_mail(c.vendor_id, r.email,
    '[' || private.mf_site(c.vendor_id) || '] ' || r.number || ' — ' || case when v_accept then 'request accepted' else 'request update' end,
    'Hello ' || r.contact || E',\n\n' ||
    case when v_accept then 'We have accepted your request ' || r.number || E' and are preparing your proforma invoice.\n'
         else 'We are unable to take up request ' || r.number || E' at this time.\n' end ||
    case when coalesce(p->>'note', '') <> '' then E'\n' || (p->>'note') || E'\n' else '' end ||
    case when v_accept and link <> '' then E'\nFollow it here: ' || link || E'\n' else '' end || E'\n' || private.mf_biz(c.vendor_id),
    private.mf_settings(c.vendor_id)->>'notify_email');
  return jsonb_build_object('ok', true, 'status', r.status);
end $$;

-- Notes and manual status changes from the order dialog. Notes are kept even
-- when the status change is refused; the refusal comes back as ok:false.
create function public.mf_admin_request_update(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  rid uuid := private.mf_request_id(c.vendor_id, p->>'id');
  e text; st text;
begin
  if rid is null then raise exception 'Request not found'; end if;
  if p ? 'admin_notes' then
    update public.requests set admin_notes = left(coalesce(p->>'admin_notes', ''), 2000), updated_at = now() where id = rid;
  end if;
  select status into st from public.requests where id = rid;
  if coalesce(p->>'status', '') <> '' and p->>'status' <> st then
    begin
      e := private.mf_set_status(rid, p->>'status', c.actor);
      if e is not null then raise exception '%', e; end if;
    exception when raise_exception then
      return jsonb_build_object('ok', false, 'error', sqlerrm);   -- the stock moves roll back; the notes stay
    end;
  end if;
  return jsonb_build_object('ok', true, 'id', p->>'id', 'status', (select status from public.requests where id = rid));
end $$;

create function public.mf_admin_orders(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  return jsonb_build_object('ok', true,
    'orders', coalesce((select jsonb_agg(private.mf_order_out(r, false) order by r.created_at desc, r.number desc)
                        from public.requests r where r.vendor_id = c.vendor_id), '[]'::jsonb),
    'statuses', to_jsonb(private.mf_statuses()), 'terminal', to_jsonb(private.mf_terminal()),
    'site_url', coalesce(private.mf_settings(c.vendor_id)->>'site_url', ''));
end $$;

/* ------------------------------------------------------------ proforma invoice */

-- Rewrite the order lines at the negotiated prices, number and total the PI,
-- and (unless send = false) mark it PI Sent and email the customer. The PDF is
-- rendered from these rows by the documents function.
create function public.mf_admin_pi_build(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  s jsonb := private.mf_settings(c.vendor_id);
  r public.requests; ln jsonb; i int := 0; v_qty int; v_total numeric := 0;
  v_days int; v_pi text; e text; old_list jsonb;
begin
  select * into r from public.requests where vendor_id = c.vendor_id and number = p->>'id' for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if jsonb_array_length(coalesce(p->'lines', '[]'::jsonb)) = 0 then raise exception 'The quotation needs at least one line'; end if;
  if not exists (select 1 from jsonb_array_elements(p->'lines') x where floor(private.mf_num(x, 'qty')) > 0) then
    raise exception 'Every line has zero quantity';
  end if;

  -- list prices survive the rewrite: they show what was discounted
  select coalesce(jsonb_object_agg(upper(l.sku), jsonb_build_object('list', coalesce(l.list_price, l.unit_price), 'name', l.name, 'hsn', l.hsn)), '{}'::jsonb)
    into old_list from public.request_lines l where l.request_id = r.id;
  delete from public.request_lines where request_id = r.id;
  for ln in select x from jsonb_array_elements(p->'lines') x loop
    v_qty := greatest(0, floor(private.mf_num(ln, 'qty')));
    continue when v_qty = 0;
    i := i + 1;
    insert into public.request_lines (vendor_id, request_id, line, sku, name, qty, unit_price, line_total, list_price, gst, hsn)
    values (c.vendor_id, r.id, i, ln->>'sku',
            coalesce(nullif(ln->>'name', ''), old_list #>> array[upper(ln->>'sku'), 'name'], ''),
            v_qty, private.mf_num(ln, 'unit_price'), v_qty * private.mf_num(ln, 'unit_price'),
            coalesce((old_list #>> array[upper(ln->>'sku'), 'list'])::numeric, private.mf_num(ln, 'unit_price')),
            private.mf_num(ln, 'gst'),
            coalesce(nullif(ln->>'hsn', ''), nullif(old_list #>> array[upper(ln->>'sku'), 'hsn'], ''),
                     (select pr.hsn from public.products pr where pr.vendor_id = c.vendor_id and upper(pr.sku) = upper(ln->>'sku')), ''));
    v_total := v_total + v_qty * private.mf_num(ln, 'unit_price') * (1 + private.mf_num(ln, 'gst') / 100);
  end loop;
  v_total := round(v_total + private.mf_num(p, 'freight') - private.mf_num(p, 'discount'), 2);

  v_days := coalesce(nullif(private.mf_num(p, 'validity_days'), 0), nullif((s->>'pi_validity_days')::numeric, 0), 15)::int;
  v_pi := coalesce(nullif(r.pi_number, ''), private.mf_next_number(c.vendor_id, 'pi', coalesce(nullif(s->>'pi_prefix', ''), 'PI'), true));
  update public.requests set
    pi_number = v_pi, pi_total = v_total, total_est = v_total,
    pi_valid_till = to_char((now() at time zone 'Asia/Kolkata')::date + v_days, 'FMDD Mon YYYY'),
    place_of_supply = coalesce(nullif(p->>'place_of_supply', ''), substring(r.gstin from '^(\d{2})'), ''),
    ship_address = case when p ? 'ship_address' then left(coalesce(p->>'ship_address', ''), 500) else ship_address end,
    pi_extras = jsonb_build_object('freight', private.mf_num(p, 'freight'), 'discount', private.mf_num(p, 'discount'), 'notes', coalesce(p->>'notes', '')),
    pi_path = '', updated_at = now()
  where id = r.id;
  perform private.mf_audit(c.vendor_id, c.actor, 'pi_built', r.number, v_pi || ' · ' || v_total);

  if coalesce(p->>'send', 'true') <> 'false' then
    e := private.mf_set_status(r.id, 'PI Sent', c.actor);
    if e is not null then raise exception '%', e; end if;
    perform private.mf_notify_pi_sent(r.id);
  end if;
  select * into r from public.requests where id = r.id;
  return jsonb_build_object('ok', true, 'pi_number', r.pi_number, 'pi_url', '', 'pi_path', r.pi_path,
                            'pi_total', r.pi_total, 'status', r.status);
end $$;

-- A PI produced outside the system: the file is already in storage at p.path.
create function public.mf_admin_pi_upload(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  s jsonb := private.mf_settings(c.vendor_id);
  r public.requests; e text;
begin
  select * into r from public.requests where vendor_id = c.vendor_id and number = p->>'id' for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if coalesce(p->>'path', '') not like c.vendor_id::text || '/%' then raise exception 'Upload the file first'; end if;
  update public.requests set
    pi_number = coalesce(nullif(p->>'pi_number', ''), nullif(pi_number, ''),
                         private.mf_next_number(c.vendor_id, 'pi', coalesce(nullif(s->>'pi_prefix', ''), 'PI'), true)),
    pi_path = p->>'path',
    pi_total = case when private.mf_num(p, 'pi_total') > 0 then private.mf_num(p, 'pi_total') else pi_total end,
    total_est = case when private.mf_num(p, 'pi_total') > 0 then private.mf_num(p, 'pi_total') else total_est end,
    pi_valid_till = coalesce(nullif(p->>'valid_till', ''), pi_valid_till), updated_at = now()
  where id = r.id returning * into r;
  perform private.mf_audit(c.vendor_id, c.actor, 'pi_upload', r.number, r.pi_number);
  if coalesce(p->>'send', 'true') <> 'false' then
    e := private.mf_set_status(r.id, 'PI Sent', c.actor);
    if e is not null then raise exception '%', e; end if;
    perform private.mf_notify_pi_sent(r.id);
  end if;
  return jsonb_build_object('ok', true, 'pi_number', r.pi_number, 'pi_path', r.pi_path);
end $$;

-- A PO that arrived by email: the file is already in storage at p.path. Deducts stock.
create function public.mf_admin_po_upload(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); r public.requests; e text;
begin
  select * into r from public.requests where vendor_id = c.vendor_id and number = p->>'id' for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if coalesce(p->>'path', '') not like c.vendor_id::text || '/%' then raise exception 'Upload the file first'; end if;
  update public.requests set po_number = coalesce(nullif(p->>'po_number', ''), po_number), po_path = p->>'path', updated_at = now()
   where id = r.id;
  e := private.mf_set_status(r.id, 'PO Received', c.actor);
  if e is not null then raise exception '%', e; end if;
  perform private.mf_audit(c.vendor_id, c.actor, 'po_upload', r.number, coalesce(nullif(p->>'po_number', ''), p->>'path'));
  perform private.mf_notify_po(r.id, 'admin');
  return jsonb_build_object('ok', true, 'po_path', p->>'path', 'status', 'PO Received');
end $$;

/* ------------------------------------------------------------ shipments */

-- Add or update one part-shipment. The order follows: any shipment → Dispatched,
-- all delivered → Delivered (unless already Delivered/Closed).
create function public.mf_admin_shipment_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  d jsonb := coalesce(p->'shipment', '{}'::jsonb);
  r public.requests; v_no int; v_status text; target text; e text; sh public.shipments; link text;
begin
  select * into r from public.requests where vendor_id = c.vendor_id and number = p->>'id' for update;
  if r.id is null then raise exception 'Request not found'; end if;
  v_no := coalesce(nullif(private.mf_num(d, 'shipment_no'), 0),
                   (select count(*) + 1 from public.shipments s where s.request_id = r.id))::int;
  v_status := case when d->>'status' = 'Delivered' then 'Delivered' else 'Dispatched' end;
  insert into public.shipments as s (vendor_id, request_id, shipment_no, ship_date, carrier, tracking, qty, note, status, delivered_on)
  values (c.vendor_id, r.id, v_no,
          coalesce(nullif(d->>'ship_date', '')::date, (now() at time zone 'Asia/Kolkata')::date),
          coalesce(d->>'carrier', ''), coalesce(d->>'tracking', ''), private.mf_num(d, 'qty')::int,
          left(coalesce(d->>'note', ''), 300), v_status,
          case when v_status = 'Delivered' then coalesce(nullif(d->>'delivered_on', '')::date, (now() at time zone 'Asia/Kolkata')::date) end)
  on conflict (request_id, shipment_no) do update set ship_date = excluded.ship_date, carrier = excluded.carrier,
     tracking = excluded.tracking, qty = excluded.qty, note = excluded.note, status = excluded.status, delivered_on = excluded.delivered_on
  returning * into sh;

  target := case when not exists (select 1 from public.shipments s where s.request_id = r.id and s.status <> 'Delivered')
                 then 'Delivered' else 'Dispatched' end;
  if r.status <> target and not (r.status = any (private.mf_active_end())) then
    e := private.mf_set_status(r.id, target, c.actor);
    if e is not null then raise exception '%', e; end if;
  end if;
  perform private.mf_audit(c.vendor_id, c.actor, 'shipment_save', r.number, 'shipment ' || v_no || ' · ' || v_status);

  link := private.mf_order_link(c.vendor_id, r.token);
  perform private.mf_mail(c.vendor_id, r.email,
    '[' || private.mf_site(c.vendor_id) || '] ' || r.number || ' — ' ||
      case when v_status = 'Delivered' then 'delivered' else 'shipment ' || v_no || ' dispatched' end,
    'Hello ' || r.contact || E',\n\nShipment ' || v_no || ' of order ' || r.number ||
      case when v_status = 'Delivered' then E' has been delivered.\n' else E' is on its way.\n' end ||
    case when sh.qty > 0 then E'\nQuantity: ' || sh.qty else '' end ||
    case when sh.carrier <> '' then E'\nCarrier: ' || sh.carrier else '' end ||
    case when sh.tracking <> '' then E'\nTracking: ' || sh.tracking else '' end ||
    case when sh.note <> '' then E'\nNote: ' || sh.note else '' end ||
    case when link <> '' then E'\n\nFull order status: ' || link || E'\n' else '' end || E'\n' || private.mf_biz(c.vendor_id),
    private.mf_settings(c.vendor_id)->>'notify_email');

  return jsonb_build_object('ok', true,
    'shipments', private.mf_order_out((select x from public.requests x where x.id = r.id), true)->'shipments',
    'status', (select status from public.requests where id = r.id));
end $$;

create function public.mf_admin_shipment_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); rid uuid := private.mf_request_id(c.vendor_id, p->>'id');
begin
  delete from public.shipments where request_id = rid and shipment_no = private.mf_num(p, 'shipment_no')::int;
  if not found then raise exception 'Shipment not found'; end if;
  return jsonb_build_object('ok', true,
    'shipments', private.mf_order_out((select x from public.requests x where x.id = rid), true)->'shipments');
end $$;

/* ------------------------------------------------------------ the customer's order page */
-- Signed-out callers, authorised by the order's 28-character token alone.

create function public.mf_order_view(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.requests;
begin
  select * into r from public.requests where token = coalesce(p->>'t', '') and coalesce(p->>'t', '') <> '';
  if r.id is null then raise exception 'This order link is not valid'; end if;
  return jsonb_build_object('ok', true, 'order', private.mf_order_out(r, true),
                            'site', jsonb_build_object('name', private.mf_site(r.vendor_id)));
end $$;

create function public.mf_order_pi_respond(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.requests; v_accept boolean := private.mf_bool(p, 'accept'); e text; who text;
begin
  select * into r from public.requests where token = coalesce(p->>'t', '') and coalesce(p->>'t', '') <> '' for update;
  if r.id is null then raise exception 'This order link is not valid'; end if;
  if r.status <> 'PI Sent' then raise exception 'This proforma is not awaiting a decision (status: %)', r.status; end if;
  who := 'client:' || r.email;
  e := private.mf_set_status(r.id, case when v_accept then 'PI Accepted' else 'Declined' end, who, left(coalesce(p->>'note', ''), 300));
  if e is not null then raise exception '%', e; end if;
  if coalesce(p->>'note', '') <> '' then
    update public.requests set admin_notes = admin_notes || E'\n[client ' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD') || '] ' || left(p->>'note', 300)
     where id = r.id;
  end if;
  perform private.mf_mail(r.vendor_id, private.mf_settings(r.vendor_id)->>'notify_email',
    '[' || private.mf_site(r.vendor_id) || '] ' || r.number || ' — proforma ' || case when v_accept then 'ACCEPTED' else 'declined' end || ' by ' || r.company,
    r.company || ' has ' || case when v_accept then 'accepted' else 'declined' end || ' proforma ' || r.pi_number || E'.\n\n' ||
    case when v_accept then E'Stock is now held for this order. The purchase order is the next step — the client can upload it from their order page, or you can add it in the console.\n'
         else E'No stock has been held.\n' end ||
    case when coalesce(p->>'note', '') <> '' then E'\nTheir note: ' || (p->>'note') || E'\n' else '' end ||
    E'\nOrder total: ₹' || private.mf_money(coalesce(r.pi_total, r.total_est)) || E'\n', r.email);
  return jsonb_build_object('ok', true, 'status', (select status from public.requests where id = r.id));
end $$;

-- The customer sends their PO. The file goes to storage through the documents
-- function; this records it and deducts the stock.
create function public.mf_order_po_upload(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.requests; e text; v_path text;
begin
  select * into r from public.requests where token = coalesce(p->>'t', '') and coalesce(p->>'t', '') <> '' for update;
  if r.id is null then raise exception 'This order link is not valid'; end if;
  if r.status not in ('PI Accepted', 'PO Received') then raise exception 'Accept the proforma invoice before sending a purchase order'; end if;
  if coalesce(p->>'path', p->>'filename', '') = '' then raise exception 'Attach the purchase order file'; end if;
  v_path := case when coalesce(p->>'path', '') like r.vendor_id::text || '/%' then p->>'path'
                 else r.vendor_id::text || '/orders/' || r.number || '/po-' || regexp_replace(coalesce(p->>'filename', 'po.pdf'), '[^A-Za-z0-9._-]', '_', 'g') end;
  update public.requests set po_number = left(coalesce(nullif(p->>'po_number', ''), po_number), 60), po_path = v_path, updated_at = now()
   where id = r.id;
  e := private.mf_set_status(r.id, 'PO Received', 'client:' || r.email);
  if e is not null then raise exception '%', e; end if;
  perform private.mf_audit(r.vendor_id, 'client:' || r.email, 'po_upload', r.number, coalesce(nullif(p->>'po_number', ''), v_path));
  perform private.mf_notify_po(r.id, 'client');
  return jsonb_build_object('ok', true, 'status', 'PO Received', 'po_path', v_path);
end $$;

/* ------------------------------------------------------------ grants */

revoke execute on all functions in schema public, private from public, anon;
grant execute on function
  public.mf_admin_request_create(jsonb), public.mf_admin_request_assign(jsonb), public.mf_admin_request_decide(jsonb),
  public.mf_admin_request_update(jsonb), public.mf_admin_orders(jsonb), public.mf_admin_pi_build(jsonb),
  public.mf_admin_pi_upload(jsonb), public.mf_admin_po_upload(jsonb),
  public.mf_admin_shipment_save(jsonb), public.mf_admin_shipment_delete(jsonb)
to authenticated;
grant execute on function public.mf_order_view(jsonb), public.mf_order_pi_respond(jsonb), public.mf_order_po_upload(jsonb)
to anon, authenticated;
grant execute on function private.mf_is_platform_admin(), private.mf_is_member(uuid), private.mf_is_vendor_admin(uuid) to authenticated;
