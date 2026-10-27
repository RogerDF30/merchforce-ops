-- Merchforce on Supabase — analytics data and CSV export.
--
-- Analytics: the reports edge function runs the original Analytics.gs
-- calculations unchanged; this hands it the vendor's rows in the shape that
-- code reads (sheet column names). CSV export keeps the Apps Script column
-- names so spreadsheets built on old exports keep working.

create function public.mf_admin_analytics_data(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  return jsonb_build_object('ok', true,
    'products', coalesce((select jsonb_agg(jsonb_build_object(
        'sku', pr.sku, 'name', pr.name, 'brand_id', coalesce(b.code, ''), 'category', pr.category,
        'moq', pr.moq, 'gst_rate', pr.gst_rate, 'lead_time', pr.lead_time, 'on_hand', pr.on_hand, 'reserved', pr.reserved,
        'safety_stock', pr.safety_stock, 'reorder_point', pr.reorder_point, 'visible', pr.visible, 'mrp', pr.mrp, 'hsn', pr.hsn))
      from public.products pr left join public.brands b on b.id = pr.brand_id where pr.vendor_id = c.vendor_id), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
        'request_id', r.number, 'created', r.created_at, 'status', r.status, 'company', r.company,
        'total_est', r.total_est, 'pi_total', coalesce(r.pi_total, 0), 'status_dates', r.status_dates::text) order by r.created_at)
      from public.requests r where r.vendor_id = c.vendor_id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('request_id', r.number, 'sku', l.sku, 'qty', l.qty, 'line_total', l.line_total))
      from public.request_lines l join public.requests r on r.id = l.request_id where l.vendor_id = c.vendor_id), '[]'::jsonb),
    'stock_log', coalesce((select jsonb_agg(jsonb_build_object('ts', s.ts, 'sku', s.sku, 'delta', s.delta, 'reason', s.reason) order by s.id)
      from public.stock_log s where s.vendor_id = c.vendor_id and s.ts > now() - interval '400 days'), '[]'::jsonb));
end $$;

create function private.mf_csv(v text) returns text language sql immutable set search_path = '' as $$
  select case when coalesce(v, '') ~ '[",\n]' then '"' || replace(v, '"', '""') || '"' else coalesce(v, '') end;
$$;

create function public.mf_admin_export_csv(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); v_tab text := coalesce(p->>'tab', ''); cols text[]; body text;
begin
  if v_tab = 'Products' then
    cols := array['sku','name','brand_id','category','subcategory','description','specs','image_urls','moq','gst_rate','lead_time',
                  'on_hand','reserved','safety_stock','reorder_point','visible','show_price','created','updated','mrp','hsn',
                  'supply_mode','vendor','vendor_moq','batch_qty','sync_seen'];
    select string_agg(array_to_string(array[pr.sku, pr.name, coalesce(b.code, ''), pr.category, pr.subcategory, pr.description, pr.specs,
             array_to_string(pr.images, '|'), pr.moq::text, pr.gst_rate::text, pr.lead_time, pr.on_hand::text, pr.reserved::text,
             pr.safety_stock::text, pr.reorder_point::text, upper(pr.visible::text), upper(pr.show_price::text), pr.created_at::text,
             pr.updated_at::text, coalesce(pr.mrp::text, ''), pr.hsn, pr.supply_mode, pr.supplier, coalesce(pr.supplier_moq::text, ''),
             coalesce(pr.batch_qty::text, ''), coalesce(pr.sync_seen::text, '')]::text[] , chr(1)), chr(10) order by pr.sku)
      into body from public.products pr left join public.brands b on b.id = pr.brand_id where pr.vendor_id = c.vendor_id;
  elsif v_tab = 'PriceTiers' then
    cols := array['sku','min_qty','unit_price','gst'];
    select string_agg(array_to_string(array[pr.sku, t.min_qty::text, t.unit_price::text, coalesce(t.gst::text, '')], chr(1)), chr(10) order by pr.sku, t.min_qty)
      into body from public.price_tiers t join public.products pr on pr.id = t.product_id where t.vendor_id = c.vendor_id;
  elsif v_tab = 'Brands' then
    cols := array['brand_id','name','logo_url','description','active','sort'];
    select string_agg(array_to_string(array[b.code, b.name, b.logo_url, b.description, upper(b.active::text), b.sort::text], chr(1)), chr(10) order by b.sort, b.name)
      into body from public.brands b where b.vendor_id = c.vendor_id;
  elsif v_tab = 'Requests' then
    cols := array['request_id','created','status','company','contact','email','phone','gstin','notes','total_est','pi_number',
                  'pi_total','po_number','ship_address','place_of_supply','company_id','raised_by','assigned_name'];
    select string_agg(array_to_string(array[r.number, r.created_at::text, r.status, r.company, r.contact, r.email, r.phone, r.gstin, r.notes,
             r.total_est::text, r.pi_number, coalesce(r.pi_total::text, ''), r.po_number, r.ship_address, r.place_of_supply,
             coalesce(co.code, ''), r.raised_by, r.assigned_name], chr(1)), chr(10) order by r.created_at)
      into body from public.requests r left join public.companies co on co.id = r.company_id where r.vendor_id = c.vendor_id;
  elsif v_tab = 'RequestLines' then
    cols := array['request_id','line','sku','name','qty','unit_price','line_total','list_price','gst','hsn'];
    select string_agg(array_to_string(array[r.number, l.line::text, l.sku, l.name, l.qty::text, l.unit_price::text, l.line_total::text,
             coalesce(l.list_price::text, ''), l.gst::text, l.hsn], chr(1)), chr(10) order by r.created_at, l.line)
      into body from public.request_lines l join public.requests r on r.id = l.request_id where l.vendor_id = c.vendor_id;
  else
    raise exception 'Tab not exportable';
  end if;
  -- quote each field, then join with commas (chr(1) is the internal field separator)
  select string_agg((select string_agg(private.mf_csv(f), ',' order by o) from unnest(string_to_array(ln, chr(1))) with ordinality u(f, o)), chr(10) order by n)
    into body from unnest(string_to_array(coalesce(body, ''), chr(10))) with ordinality x(ln, n) where ln <> '';
  return jsonb_build_object('ok', true,
    'filename', 'merchforce_' || lower(v_tab) || '_' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD') || '.csv',
    'csv', array_to_string(cols, ',') || case when coalesce(body, '') <> '' then chr(10) || body else '' end);
end $$;

revoke execute on function public.mf_admin_analytics_data(jsonb), public.mf_admin_export_csv(jsonb) from public, anon;
grant execute on function public.mf_admin_analytics_data(jsonb), public.mf_admin_export_csv(jsonb) to authenticated;
