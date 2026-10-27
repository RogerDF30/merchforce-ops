-- Merchforce on Supabase — staff accounts.
--
-- Listing is plain SQL. Creating a sign-in or setting a password needs the
-- Auth admin API, so the admin-users edge function does that part: it checks
-- the caller is this vendor's admin (mf_admin_users with the caller's token),
-- then uses the service role for the mf_service_* functions below, which the
-- browser cannot call at all.
--
-- On a shared platform a vendor admin must not take over a sign-in that other
-- vendors (or CompanyStore) also use: mf_service_user_lookup reports that, and
-- the edge function refuses to change such a password.

create function public.mf_admin_users(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p, true);
begin
  return jsonb_build_object('ok', true, 'vendor_id', c.vendor_id, 'me', c.actor,
    'users', coalesce((select jsonb_agg(jsonb_build_object('email', m.email, 'name', m.name, 'company', '',
                 'role', m.role, 'active', m.active, 'created', m.created_at::text,
                 'last_login', coalesce(m.last_login::text, '')) order by m.name)
               from public.vendor_members m where m.vendor_id = c.vendor_id), '[]'::jsonb));
end $$;

create function public.mf_service_user_lookup(p jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', true,
    'user_id', u.id,
    'platform', exists (select 1 from public.platform_admins pa where pa.user_id = u.id),
    'other_vendors', (select count(*) from public.vendor_members m where m.user_id = u.id and m.vendor_id <> (p->>'vendor_id')::uuid))
  from (select null) x left join auth.users u on lower(u.email) = lower(trim(p->>'email'));
$$;

create function public.mf_service_member_upsert(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v uuid := (p->>'vendor_id')::uuid; uid uuid; v_email text := lower(trim(coalesce(p->>'email', '')));
begin
  select id into uid from auth.users where lower(email) = v_email;
  if uid is null then raise exception 'No sign-in exists for %', v_email; end if;
  insert into public.vendor_members as m (vendor_id, user_id, role, name, email, active)
  values (v, uid, case when p->>'role' = 'admin' then 'admin' else 'staff' end, coalesce(p->>'name', ''), v_email,
          coalesce((p->>'active')::boolean, true))
  on conflict (vendor_id, user_id) do update set
    role = case when p ? 'role' then excluded.role else m.role end,
    name = case when p ? 'name' then excluded.name else m.name end,
    active = case when p ? 'active' then excluded.active else m.active end;
  perform private.mf_audit(v, coalesce(p->>'actor', 'admin'), 'user_save', v_email);
  return jsonb_build_object('ok', true, 'user_id', uid);
end $$;

revoke execute on function public.mf_admin_users(jsonb), public.mf_service_user_lookup(jsonb), public.mf_service_member_upsert(jsonb) from public, anon, authenticated;
grant execute on function public.mf_admin_users(jsonb) to authenticated;
grant execute on function public.mf_service_user_lookup(jsonb), public.mf_service_member_upsert(jsonb) to service_role;
