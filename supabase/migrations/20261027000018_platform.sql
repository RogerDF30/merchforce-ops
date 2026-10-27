-- Merchforce on Supabase — platform admin (CompanyStore): create vendors.
-- A new vendor gets its own address (site_url, used in customer email links),
-- its own settings and secrets, and mail on. Its first admin sign-in is
-- created by the admin-users edge function (platformVendorCreate).

create or replace function public.mf_platform_vendor_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v uuid; v_slug text := lower(trim(coalesce(p->>'slug', ''))); nm text := trim(coalesce(p->>'name', ''));
begin
  if not private.mf_is_platform_admin() then raise exception 'Only a platform admin can do that'; end if;
  if nm = '' then raise exception 'Give the vendor a name'; end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,39}$' then raise exception 'Subdomain must be 2–40 lowercase letters, digits or hyphens'; end if;
  if v_slug in ('www', 'app', 'admin', 'platform', 'api', 'mail', 'notifications') then raise exception 'That subdomain is reserved: %', v_slug; end if;
  if exists (select 1 from public.vendors x where x.slug = v_slug) then raise exception 'That subdomain is already taken: %', v_slug; end if;
  insert into public.vendors (slug, name) values (v_slug, nm) returning id into v;
  insert into public.vendor_settings (vendor_id, settings)
  values (v, jsonb_build_object('app_name', nm, 'site_name', nm, 'co_name', coalesce(nullif(p->>'co_name', ''), nm),
                                'site_url', 'https://' || v_slug || '.merchforce.io',
                                'notify_email', coalesce(p->>'notify_email', '')));
  insert into public.vendor_secrets (vendor_id) values (v);
  perform private.mf_audit(null, (select email from auth.users where id = auth.uid()), 'vendor_create', v_slug, nm);
  return jsonb_build_object('ok', true, 'vendor', jsonb_build_object('id', v, 'slug', v_slug, 'name', nm,
                            'url', 'https://' || v_slug || '.merchforce.io'));
end $$;

-- Vendors list gains each vendor's address and admins.
create or replace function public.mf_platform_vendors(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.mf_is_platform_admin() then raise exception 'Only a platform admin can do that'; end if;
  return jsonb_build_object('ok', true, 'vendors', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', v.id, 'slug', v.slug, 'name', v.name, 'active', v.active, 'created', v.created_at,
      'url', 'https://' || v.slug || '.merchforce.io',
      'admins', (select coalesce(jsonb_agg(m.email order by m.email), '[]'::jsonb) from public.vendor_members m where m.vendor_id = v.id and m.role = 'admin' and m.active),
      'members', (select count(*) from public.vendor_members m where m.vendor_id = v.id and m.active),
      'products', (select count(*) from public.products pr where pr.vendor_id = v.id),
      'orders', (select count(*) from public.requests r where r.vendor_id = v.id),
      'last_order', (select max(r.created_at) from public.requests r where r.vendor_id = v.id),
      'mail_mode', private.mf_settings(v.id)->>'mail_mode') order by v.name)
    from public.vendors v), '[]'::jsonb));
end $$;

revoke execute on function public.mf_platform_vendor_create(jsonb), public.mf_platform_vendors(jsonb) from public, anon;
grant execute on function public.mf_platform_vendor_create(jsonb), public.mf_platform_vendors(jsonb) to authenticated;
