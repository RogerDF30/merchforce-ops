-- Vendor isolation: run against a database with the migrations applied.
-- Each check raises if it fails; the last line prints PASS.
begin;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@crystal.test'),
  ('00000000-0000-0000-0000-00000000000b', 'b@ninedots.test'),
  ('00000000-0000-0000-0000-00000000000c', 'ops@companystore.test');
insert into public.vendors (id, slug, name) values
  ('10000000-0000-0000-0000-00000000000a', 'crystalcorner', 'Crystal Corner'),
  ('10000000-0000-0000-0000-00000000000b', 'ninedots', 'Nine Dots');
insert into public.vendor_members (vendor_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'admin'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'staff');
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-00000000000c');
insert into public.products (vendor_id, sku, name, on_hand) values
  ('10000000-0000-0000-0000-00000000000a', 'CC-1', 'Crystal trophy', 50),
  ('10000000-0000-0000-0000-00000000000b', 'ND-1', 'Notebook', 80);
insert into public.vendor_secrets (vendor_id, relay_secret) values ('10000000-0000-0000-0000-00000000000a', 's3cret');

do $$ begin
  -- user A (Crystal Corner admin)
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
  set local role authenticated;
  if (select count(*) from public.products) <> 1 then raise exception 'A should see exactly 1 product'; end if;
  if (select sku from public.products) <> 'CC-1' then raise exception 'A saw the wrong vendor''s product'; end if;
  if (select count(*) from public.vendors) <> 1 then raise exception 'A should see only their vendor'; end if;
  begin
    insert into public.products (vendor_id, sku, name) values ('10000000-0000-0000-0000-00000000000a', 'X', 'x');
    raise exception 'A could insert directly';
  exception when insufficient_privilege then null; end;
  begin
    update public.products set on_hand = 9999;
    raise exception 'A could update directly';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.vendor_secrets;
    raise exception 'A could read secrets';
  exception when insufficient_privilege then null; end;
  reset role;

  -- user B (Nine Dots staff)
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
  set local role authenticated;
  if (select string_agg(sku, ',') from public.products) <> 'ND-1' then raise exception 'B isolation broken'; end if;
  if private.mf_is_vendor_admin('10000000-0000-0000-0000-00000000000b') then raise exception 'staff treated as admin'; end if;
  reset role;

  -- platform admin sees both
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
  set local role authenticated;
  if (select count(*) from public.products where vendor_id in ('10000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000b')) <> 2 then raise exception 'platform admin should see both vendors'; end if;
  reset role;

  -- signed out
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
  begin
    perform * from public.products;
    raise exception 'anon could read products';
  exception when insufficient_privilege then null; end;
  reset role;
end $$;
select 'PASS rls_isolation' as result;
rollback;
