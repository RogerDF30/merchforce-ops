-- Core function layer: context, settings, numbering, platform vendor creation.
begin;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@crystal.test'),
  ('00000000-0000-0000-0000-00000000000b', 'b@crystal.test'),
  ('00000000-0000-0000-0000-00000000000c', 'ops@companystore.test');
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-00000000000c');

do $$
declare r jsonb; v uuid;
begin
  -- platform admin creates a vendor
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
  set local role authenticated;
  r := public.mf_platform_vendor_create('{"slug":"crystalcorner","name":"Crystal Corner"}');
  if not (r->>'ok')::boolean then raise exception 'vendor create failed'; end if;
  begin
    perform public.mf_platform_vendor_create('{"slug":"crystalcorner","name":"Dup"}');
    raise exception 'duplicate slug allowed';
  exception when raise_exception then
    if sqlerrm not like 'That subdomain is already taken%' then raise; end if;
  end;
  begin
    perform public.mf_platform_vendor_create('{"slug":"Bad Slug!","name":"X"}');
    raise exception 'bad slug allowed';
  exception when raise_exception then
    if sqlerrm not like 'Subdomain must be%' then raise; end if;
  end;
  reset role;

  v := (select id from public.vendors where slug = 'crystalcorner');
  insert into public.vendor_members (vendor_id, user_id, role, name, email) values
    (v, '00000000-0000-0000-0000-00000000000a', 'admin', 'Asha', 'a@crystal.test'),
    (v, '00000000-0000-0000-0000-00000000000b', 'staff', 'Bala', 'b@crystal.test');

  -- non-admin cannot create vendors
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
  set local role authenticated;
  begin
    perform public.mf_platform_vendor_create('{"slug":"other","name":"Other"}');
    raise exception 'vendor admin could create vendors';
  exception when raise_exception then
    if sqlerrm <> 'Only a platform admin can do that' then raise; end if;
  end;

  -- me + settings defaults overlaid with the vendor name
  r := public.mf_me('{"vendor":"crystalcorner"}');
  if r#>>'{user,role}' <> 'admin' or r#>>'{settings,app_name}' <> 'Crystal Corner' or r#>>'{settings,pi_prefix}' <> 'PI' then
    raise exception 'mf_me wrong: %', r; end if;

  -- admin saves settings; unknown keys ignored; relay secret goes to secrets
  r := public.mf_admin_settings('{"vendor":"crystalcorner","save":{"notify_email":"orders@crystal.test","relay_secret":"abc","not_a_key":"x"}}');
  if r#>>'{settings,notify_email}' <> 'orders@crystal.test' or r#>>'{settings,relay_secret}' <> 'abc' or r->'settings' ? 'not_a_key' then
    raise exception 'settings save wrong: %', r; end if;
  if (select settings ? 'relay_secret' from public.vendor_settings where vendor_id = v) then raise exception 'secret leaked into settings'; end if;
  reset role;

  -- staff cannot open settings, can list staff
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
  set local role authenticated;
  begin
    perform public.mf_admin_settings('{"vendor":"crystalcorner"}');
    raise exception 'staff opened settings';
  exception when raise_exception then
    if sqlerrm <> 'Only an admin can do that' then raise; end if;
  end;
  if jsonb_array_length(public.mf_admin_staff_list('{"vendor":"crystalcorner"}')->'staff') <> 2 then raise exception 'staff list wrong'; end if;
  begin
    perform public.mf_me('{"vendor":"nosuch"}');
    raise exception 'unknown vendor accepted';
  exception when raise_exception then
    if sqlerrm not like 'Unknown vendor%' then raise; end if;
  end;
  reset role;

  -- signed out
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.mf_me('{"vendor":"crystalcorner"}');
    raise exception 'signed-out call accepted';
  exception when raise_exception then
    if sqlerrm not like 'Your session has expired%' then raise; end if;
  end;

  -- numbering
  if private.mf_next_number(v, 'request', 'MF', true) not like 'MF-20__-0001' then raise exception 'numbering wrong'; end if;
  if private.mf_next_number(v, 'request', 'MF', true) not like 'MF-20__-0002' then raise exception 'numbering not incrementing'; end if;
  if private.mf_next_number(v, 'rma', 'RMA', false) <> 'RMA-0001' then raise exception 'non-yearly numbering wrong'; end if;
  if length(private.mf_token()) <> 28 then raise exception 'token length wrong'; end if;
end $$;

-- anon cannot call actions at all
set role anon;
do $$ begin
  perform public.mf_me('{"vendor":"crystalcorner"}');
  raise exception 'anon could execute mf_me';
exception when insufficient_privilege then null; end $$;
reset role;
select 'PASS core_functions' as result;
rollback;
