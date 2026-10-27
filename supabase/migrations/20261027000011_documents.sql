-- Merchforce on Supabase — helpers for the files edge function (PI PDFs,
-- uploads, signed links). Service role only: the browser cannot call these.

-- The customer's order page uploads by token alone; the function needs the
-- vendor and order number to build the storage path.
create function public.mf_service_order_by_token(p jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('ok', true, 'vendor_id', r.vendor_id, 'number', r.number, 'status', r.status)
                     from public.requests r where r.token = coalesce(p->>'t', '') and coalesce(p->>'t', '') <> ''),
                  jsonb_build_object('ok', false, 'error', 'This order link is not valid'));
$$;

-- Everything a PI prints: the order, its lines, the issuer's settings, state names.
create function public.mf_service_pi_data(p jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', true,
    'order', to_jsonb(r) - 'token',
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.line) from public.request_lines l where l.request_id = r.id), '[]'::jsonb),
    'settings', private.mf_settings(r.vendor_id),
    'states', (select jsonb_object_agg(g.code, g.name) from private.gst_states g))
  from public.requests r where r.vendor_id = (p->>'vendor_id')::uuid and r.number = p->>'number';
$$;

create function public.mf_service_set_pi_path(p jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  update public.requests set pi_path = p->>'path', updated_at = now()
   where vendor_id = (p->>'vendor_id')::uuid and number = p->>'number'
  returning jsonb_build_object('ok', true);
$$;

revoke execute on function public.mf_service_order_by_token(jsonb), public.mf_service_pi_data(jsonb), public.mf_service_set_pi_path(jsonb) from public, anon, authenticated;
grant execute on function public.mf_service_order_by_token(jsonb), public.mf_service_pi_data(jsonb), public.mf_service_set_pi_path(jsonb) to service_role;
