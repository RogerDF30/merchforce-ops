-- Merchforce on Supabase — the function layer every action builds on.
--
-- public holds only the API (mf_* actions); helpers are in private.
-- The console calls api('someAction', body); the client maps that to
-- rpc('mf_some_action', {p: body}). Each mf_* function returns the same
-- {ok: true, ...} object the Apps Script backend returned, and raises with a
-- plain-English message where the old backend returned {ok:false, error}.
-- body.vendor carries the vendor slug the console is open for.

/* ------------------------------------------------------------ caller context */

create type private.mf_ctx as (vendor_id uuid, user_id uuid, role text, actor text, email text);

-- Who is calling, for which vendor, and may they? need_admin: vendor admins only.
create function private.mf_ctx(p jsonb, need_admin boolean default false) returns private.mf_ctx
language plpgsql stable security definer set search_path = '' as $$
declare
  c private.mf_ctx;
  v_slug text := lower(coalesce(p->>'vendor', ''));
begin
  c.user_id := auth.uid();
  if c.user_id is null then raise exception 'Your session has expired. Sign in again.'; end if;
  select v.id into c.vendor_id from public.vendors v where v.slug = v_slug and v.active;
  if c.vendor_id is null then raise exception 'Unknown vendor: %', coalesce(nullif(v_slug, ''), '(none)'); end if;

  select m.role, coalesce(nullif(m.name, ''), m.email), m.email into c.role, c.actor, c.email
    from public.vendor_members m
   where m.vendor_id = c.vendor_id and m.user_id = c.user_id and m.active;
  if c.role is null then
    if not private.mf_is_platform_admin() then raise exception 'You do not have access to this vendor'; end if;
    c.role := 'admin';
    select u.email into c.email from auth.users u where u.id = c.user_id;
    c.actor := coalesce(c.email, 'platform');
  end if;
  if need_admin and c.role <> 'admin' then raise exception 'Only an admin can do that'; end if;
  return c;
end $$;

/* ------------------------------------------------------------ numbering & audit */

-- Next running number for a vendor: per_year → PREFIX-2026-0001, else PREFIX-0001.
create function private.mf_next_number(v uuid, counter text, prefix text, per_year boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  y int := case when per_year then extract(year from now() at time zone 'Asia/Kolkata')::int else 0 end;
  n int;
begin
  insert into public.counters (vendor_id, name, year, value) values (v, counter, y, 1)
  on conflict (vendor_id, name, year) do update set value = public.counters.value + 1
  returning value into n;
  return prefix || '-' || case when per_year then y::text || '-' else '' end || lpad(n::text, 4, '0');
end $$;

create function private.mf_audit(v uuid, actor text, action text, ref text default '', detail text default '') returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_log (vendor_id, actor, action, ref, detail)
  values (v, coalesce(actor, ''), action, coalesce(ref, ''), left(coalesce(detail, ''), 2000));
$$;

-- 28-character unguessable token for customer order links.
create function private.mf_token() returns text
language sql volatile set search_path = '' as $$
  select translate(encode(extensions.gen_random_bytes(21), 'base64'), '+/=', '-_');
$$;

/* ------------------------------------------------------------ settings */

create function private.mf_default_settings() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'site_name', 'Merchforce', 'tagline', 'Bulk merchandise, direct from stock',
    'app_name', 'Merchforce', 'app_tagline', 'Enquiries, orders, stock and decks in one place', 'app_logo_url', '',
    'notify_email', '', 'mail_mode', 'backend', 'mail_from_name', '', 'relay_url', '',
    'low_stock_threshold', '25', 'currency', 'INR',
    'co_name', '', 'co_address', '', 'co_state', '', 'co_state_code', '', 'co_gstin', '', 'co_pan', '',
    'co_phone', '', 'co_email', '', 'co_bank', '', 'co_terms', '', 'co_logo_url', '', 'co_sign_url', '',
    'pi_prefix', 'PI', 'pi_validity_days', '15',
    'deck_accent', '#2447F5', 'deck_ink', '#1D1D1F', 'deck_muted', '#6E6E73', 'deck_plate', '#F5F5F7', 'deck_layout', 'compact',
    'session_minutes', '30', 'reorder_alert', 'off', 'site_url', '', 'primary_color', '#1a1f36',
    'sync_auto', 'off', 'sync_last', '');
$$;

-- Effective settings for a vendor: defaults overlaid with what the vendor saved.
create function private.mf_settings(v uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select private.mf_default_settings() || coalesce((select s.settings from public.vendor_settings s where s.vendor_id = v), '{}'::jsonb);
$$;

/* ------------------------------------------------------------ actions: session & settings */

-- What the console needs after sign-in: who I am, which vendor, its settings.
create function public.mf_me(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); s jsonb;
begin
  update public.vendor_members set last_login = now() where vendor_id = c.vendor_id and user_id = c.user_id;
  s := private.mf_settings(c.vendor_id);
  return jsonb_build_object('ok', true,
    'user', jsonb_build_object('email', c.email, 'name', c.actor, 'role', c.role),
    'vendor', (select jsonb_build_object('slug', v.slug, 'name', v.name) from public.vendors v where v.id = c.vendor_id),
    'settings', s,
    'session_minutes', (s->>'session_minutes')::int);
end $$;

-- Admin: read settings, optionally saving a patch first. The relay secret is
-- kept out of vendor_settings and shown to admins only, as the old backend did.
create function public.mf_admin_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p, true); patch jsonb := coalesce(p->'save', '{}'::jsonb); secret text;
begin
  if patch ? 'relay_secret' then
    insert into public.vendor_secrets (vendor_id, relay_secret) values (c.vendor_id, coalesce(patch->>'relay_secret', ''))
    on conflict (vendor_id) do update set relay_secret = excluded.relay_secret;
    patch := patch - 'relay_secret';
  end if;
  if patch <> '{}'::jsonb then
    -- only keys the app knows about; everything is stored as text, as the sheet did
    select coalesce(jsonb_object_agg(key, to_jsonb(value)), '{}'::jsonb) into patch
      from jsonb_each_text(patch) where private.mf_default_settings() ? key;
    insert into public.vendor_settings (vendor_id, settings) values (c.vendor_id, patch)
    on conflict (vendor_id) do update set settings = public.vendor_settings.settings || excluded.settings, updated_at = now();
    perform private.mf_audit(c.vendor_id, c.actor, 'settings_save', '', (select string_agg(k, ', ') from jsonb_object_keys(patch) k));
  end if;
  select s.relay_secret into secret from public.vendor_secrets s where s.vendor_id = c.vendor_id;
  return jsonb_build_object('ok', true,
    'settings', private.mf_settings(c.vendor_id) || jsonb_build_object('relay_secret', coalesce(secret, '')),
    'relay_status', null);
end $$;

-- Active staff for owner / follow-up pickers.
create function public.mf_admin_staff_list(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  return jsonb_build_object('ok', true, 'staff', coalesce((
    select jsonb_agg(jsonb_build_object('email', m.email, 'name', coalesce(nullif(m.name, ''), m.email), 'role', m.role) order by m.name)
      from public.vendor_members m where m.vendor_id = c.vendor_id and m.active), '[]'::jsonb));
end $$;

/* ------------------------------------------------------------ platform: vendors */

-- CompanyStore only: create a vendor. Staff accounts are added by the
-- platform-admin edge function, which can create sign-ins.
create function public.mf_platform_vendor_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v uuid; v_slug text := lower(trim(coalesce(p->>'slug', ''))); nm text := trim(coalesce(p->>'name', ''));
begin
  if not private.mf_is_platform_admin() then raise exception 'Only a platform admin can do that'; end if;
  if nm = '' then raise exception 'Give the vendor a name'; end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,39}$' then raise exception 'Subdomain must be 2–40 lowercase letters, digits or hyphens'; end if;
  if exists (select 1 from public.vendors x where x.slug = v_slug) then raise exception 'That subdomain is already taken: %', v_slug; end if;
  insert into public.vendors (slug, name) values (v_slug, nm) returning id into v;
  insert into public.vendor_settings (vendor_id, settings)
  values (v, jsonb_build_object('app_name', nm, 'site_name', nm, 'co_name', coalesce(p->>'co_name', nm)));
  insert into public.vendor_secrets (vendor_id) values (v);
  perform private.mf_audit(null, (select email from auth.users where id = auth.uid()), 'vendor_create', v_slug, nm);
  return jsonb_build_object('ok', true, 'vendor', jsonb_build_object('id', v, 'slug', v_slug, 'name', nm));
end $$;

create function public.mf_platform_vendors(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.mf_is_platform_admin() then raise exception 'Only a platform admin can do that'; end if;
  return jsonb_build_object('ok', true, 'vendors', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', v.id, 'slug', v.slug, 'name', v.name, 'active', v.active, 'created', v.created_at,
      'members', (select count(*) from public.vendor_members m where m.vendor_id = v.id and m.active),
      'orders', (select count(*) from public.requests r where r.vendor_id = v.id),
      'last_order', (select max(r.created_at) from public.requests r where r.vendor_id = v.id)) order by v.name)
    from public.vendors v), '[]'::jsonb));
end $$;

/* ------------------------------------------------------------ grants */

revoke execute on all functions in schema public, private from public, anon;
grant execute on function
  public.mf_me(jsonb), public.mf_admin_settings(jsonb), public.mf_admin_staff_list(jsonb),
  public.mf_platform_vendor_create(jsonb), public.mf_platform_vendors(jsonb)
to authenticated;
