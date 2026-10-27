-- Merchforce on Supabase — CompanyStore platform admins: editors and viewers.
--
-- editor: creates vendors, manages platform admins, and acts as admin inside
--         any vendor (every change recorded under their own email).
-- viewer: sees every vendor, catalogue and console, changes nothing.
--
-- View-only is enforced by the database, not by hiding buttons: mf_ctx marks a
-- viewer's transaction, and a trigger on every table refuses any insert,
-- update or delete in it. A missed button or a hand-made API call cannot write.

alter table public.platform_admins
  add column role text not null default 'editor' check (role in ('editor', 'viewer')),
  add column name text not null default '',
  add column email text not null default '',
  add column created_by text not null default '';
update public.platform_admins pa set email = u.email from auth.users u where u.id = pa.user_id;

create function private.mf_platform_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.platform_admins where user_id = auth.uid();
$$;
create function private.mf_is_platform_editor() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.mf_platform_role() = 'editor', false);
$$;

/* ------------------------------------------------------------ the guard */

create function private.mf_viewer_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_setting('mf.viewer', true) = 'on' then
    raise exception 'You have view-only access, so you cannot make changes';
  end if;
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['vendors', 'platform_admins', 'vendor_members', 'vendor_settings', 'vendor_secrets', 'counters',
                           'brands', 'products', 'price_tiers', 'companies', 'contacts', 'account_notes', 'account_files',
                           'requests', 'request_lines', 'shipments', 'returns', 'return_lines', 'supply_orders', 'decks',
                           'stock_log', 'audit_log', 'sync_maps']
  loop
    execute format('create trigger mf_viewer_guard before insert or update or delete on public.%I for each statement execute function private.mf_viewer_guard()', t);
  end loop;
end $$;
create trigger mf_viewer_guard before insert or update or delete on private.outbox for each statement execute function private.mf_viewer_guard();

/* ------------------------------------------------------------ caller context */

-- Members act with their vendor role. A platform admin who is not a member acts
-- as 'admin' (editor) or 'viewer'; a viewer's transaction is marked read-only.
create or replace function private.mf_ctx(p jsonb, need_admin boolean default false) returns private.mf_ctx
language plpgsql volatile security definer set search_path = '' as $$
declare
  c private.mf_ctx;
  v_slug text := lower(coalesce(p->>'vendor', ''));
  prole text;
begin
  c.user_id := auth.uid();
  if c.user_id is null then raise exception 'Your session has expired. Sign in again.'; end if;
  select v.id into c.vendor_id from public.vendors v where v.slug = v_slug and v.active;
  if c.vendor_id is null then raise exception 'Unknown vendor: %', coalesce(nullif(v_slug, ''), '(none)'); end if;

  select m.role, coalesce(nullif(m.name, ''), m.email), m.email into c.role, c.actor, c.email
    from public.vendor_members m
   where m.vendor_id = c.vendor_id and m.user_id = c.user_id and m.active;
  if c.role is null then
    prole := private.mf_platform_role();
    if prole is null then raise exception 'You do not have access to this vendor'; end if;
    select u.email into c.email from auth.users u where u.id = c.user_id;
    c.actor := coalesce((select nullif(pa.name, '') from public.platform_admins pa where pa.user_id = c.user_id), c.email, 'platform');
    if prole = 'viewer' then
      c.role := 'viewer';
      perform set_config('mf.viewer', 'on', true);          -- this transaction can no longer write
    else
      c.role := 'admin';
    end if;
  end if;
  if need_admin and c.role <> 'admin' then
    raise exception '%', case when c.role = 'viewer' then 'You have view-only access, so you cannot make changes' else 'Only an admin can do that' end;
  end if;
  return c;
end $$;

-- Edge functions ask this before storing a file, so a viewer never leaves files behind.
create function public.mf_can_write(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  if c.role = 'viewer' then raise exception 'You have view-only access, so you cannot make changes'; end if;
  return jsonb_build_object('ok', true, 'vendor_id', c.vendor_id);
end $$;

/* ------------------------------------------------------------ platform actions */

-- Creating vendors is for editors.
create or replace function public.mf_platform_vendor_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v uuid; v_slug text := lower(trim(coalesce(p->>'slug', ''))); nm text := trim(coalesce(p->>'name', ''));
begin
  if not private.mf_is_platform_admin() then raise exception 'Only a platform admin can do that'; end if;
  if not private.mf_is_platform_editor() then raise exception 'You have view-only access, so you cannot make changes'; end if;
  if nm = '' then raise exception 'Give the vendor a name'; end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,39}$' then raise exception 'Subdomain must be 2–40 lowercase letters, digits or hyphens'; end if;
  if v_slug in ('www', 'app', 'admin', 'platform', 'api', 'mail', 'notifications') then raise exception 'That subdomain is reserved: %', v_slug; end if;
  if exists (select 1 from public.vendors x where x.slug = v_slug) then raise exception 'That subdomain is already taken: %', v_slug; end if;
  insert into public.vendors (slug, name) values (v_slug, nm) returning id into v;
  insert into public.vendor_settings (vendor_id, settings)
  values (v, jsonb_build_object('app_name', nm, 'site_name', nm, 'co_name', coalesce(nullif(p->>'co_name', ''), nm),
                                'site_url', 'https://' || v_slug || '.merchforce.io', 'notify_email', coalesce(p->>'notify_email', '')));
  insert into public.vendor_secrets (vendor_id) values (v);
  perform private.mf_audit(null, (select email from auth.users where id = auth.uid()), 'vendor_create', v_slug, nm);
  return jsonb_build_object('ok', true, 'vendor', jsonb_build_object('id', v, 'slug', v_slug, 'name', nm, 'url', 'https://' || v_slug || '.merchforce.io'));
end $$;

-- Who am I on the platform (for the platform screen).
create function public.mf_platform_me(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.platform_admins;
begin
  select * into r from public.platform_admins where user_id = auth.uid();
  if r.user_id is null then raise exception 'Only a platform admin can do that'; end if;
  return jsonb_build_object('ok', true, 'me', jsonb_build_object('email', r.email, 'name', r.name, 'role', r.role));
end $$;

create function public.mf_platform_admins(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.mf_is_platform_admin() then raise exception 'Only a platform admin can do that'; end if;
  return jsonb_build_object('ok', true, 'admins', coalesce((select jsonb_agg(jsonb_build_object(
      'email', pa.email, 'name', pa.name, 'role', pa.role, 'created', pa.created_at, 'created_by', pa.created_by,
      'you', pa.user_id = auth.uid()) order by pa.role, pa.email) from public.platform_admins pa), '[]'::jsonb));
end $$;

-- Editors add, change or remove platform admins. The sign-in itself is made by
-- the admin-users function (Auth admin API) before this is called.
create function public.mf_platform_admin_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid; v_email text := lower(trim(coalesce(p->>'email', ''))); v_role text := coalesce(p->>'role', 'viewer');
        me text := (select email from auth.users where id = auth.uid());
begin
  if not private.mf_is_platform_editor() then raise exception 'Only a platform editor can manage platform admins'; end if;
  if v_role not in ('editor', 'viewer') then raise exception 'Role must be editor or viewer'; end if;
  select id into uid from auth.users where lower(email) = v_email;
  if uid is null then raise exception 'No sign-in exists for %', v_email; end if;
  if uid = auth.uid() and v_role <> 'editor' then raise exception 'You cannot remove your own editor rights'; end if;
  insert into public.platform_admins as pa (user_id, role, name, email, created_by)
  values (uid, v_role, coalesce(p->>'name', ''), v_email, me)
  on conflict (user_id) do update set role = excluded.role,
    name = case when p ? 'name' then excluded.name else pa.name end, email = excluded.email;
  perform private.mf_audit(null, me, 'platform_admin_save', v_email, v_role);
  return jsonb_build_object('ok', true, 'email', v_email, 'role', v_role);
end $$;

create function public.mf_platform_admin_remove(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid; v_email text := lower(trim(coalesce(p->>'email', ''))); me text := (select email from auth.users where id = auth.uid());
begin
  if not private.mf_is_platform_editor() then raise exception 'Only a platform editor can manage platform admins'; end if;
  select pa.user_id into uid from public.platform_admins pa where lower(pa.email) = v_email;
  if uid is null then raise exception 'Not a platform admin: %', v_email; end if;
  if uid = auth.uid() then raise exception 'You cannot remove yourself'; end if;
  delete from public.platform_admins where user_id = uid;
  perform private.mf_audit(null, me, 'platform_admin_remove', v_email, '');
  return jsonb_build_object('ok', true, 'email', v_email);
end $$;

-- mf_me: the console's banner needs the platform role.
create or replace function public.mf_me(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); s jsonb; n_review int; n_img int; v_member boolean;
begin
  v_member := exists (select 1 from public.vendor_members m where m.vendor_id = c.vendor_id and m.user_id = c.user_id and m.active);
  if v_member then
    update public.vendor_members set last_login = now() where vendor_id = c.vendor_id and user_id = c.user_id;
  end if;
  s := private.mf_settings(c.vendor_id);
  select count(*) filter (where review_pending), count(*) filter (where image_error <> '')
    into n_review, n_img from public.products where vendor_id = c.vendor_id;
  return jsonb_build_object('ok', true,
    'user', jsonb_build_object('email', c.email, 'name', c.actor, 'role', c.role,
                               'platform', private.mf_is_platform_admin(), 'platform_role', private.mf_platform_role(),
                               'acting_for', not v_member),
    'vendor', (select jsonb_build_object('slug', v.slug, 'name', v.name) from public.vendors v where v.id = c.vendor_id),
    'settings', s, 'session_minutes', (s->>'session_minutes')::int,
    'notices', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
       select jsonb_build_object('type', 'products_review', 'count', n_review, 'tab', 'catalog',
              'text', case when n_review = 1 then '1 new product from your stock sheet is hidden. Review it to make it available.'
                           else n_review || ' new products from your stock sheet are hidden. Review them to make them available.' end) as x
        where n_review > 0
       union all
       select jsonb_build_object('type', 'image_errors', 'count', n_img, 'tab', 'catalog',
              'text', case when n_img = 1 then '1 product image link from your sheet could not be imported. Check that the link is public.'
                           else n_img || ' product image links from your sheet could not be imported. Check that the links are public.' end)
        where n_img > 0) y));
end $$;

revoke execute on all functions in schema public, private from public, anon;
grant execute on function public.mf_can_write(jsonb), public.mf_platform_me(jsonb), public.mf_platform_admins(jsonb),
  public.mf_platform_admin_save(jsonb), public.mf_platform_admin_remove(jsonb), public.mf_platform_vendor_create(jsonb),
  public.mf_me(jsonb) to authenticated;
grant execute on function public.mf_order_view(jsonb), public.mf_order_pi_respond(jsonb), public.mf_order_po_upload(jsonb) to anon, authenticated;
grant execute on function private.mf_is_platform_admin(), private.mf_is_member(uuid), private.mf_is_vendor_admin(uuid),
  private.mf_member_of_path(text), private.mf_platform_role(), private.mf_is_platform_editor() to authenticated;
