-- Merchforce on Supabase — file storage.
--
-- Every object lives under its vendor's folder: <vendor_id>/... The first path
-- segment is checked against membership, so staff reach only their vendor's
-- files. 'docs' is private (PIs, POs, credit notes, account files, decks);
-- customers get their PI through a short-lived signed link from the files
-- edge function, which checks the order token. 'images' is publicly readable
-- (product photos, logos, signatures) but only a vendor's members can write it.

insert into storage.buckets (id, name, public, file_size_limit)
values ('docs', 'docs', false, 10485760),
       ('images', 'images', true, 4194304)
on conflict (id) do nothing;

create function private.mf_member_of_path(object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.vendor_members m
                  where m.vendor_id::text = (storage.foldername(object_name))[1]
                    and m.user_id = auth.uid() and m.active)
         or private.mf_is_platform_admin();
$$;
grant execute on function private.mf_member_of_path(text) to authenticated;

create policy mf_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'docs' and private.mf_member_of_path(name));
create policy mf_docs_write on storage.objects for insert to authenticated
  with check (bucket_id = 'docs' and private.mf_member_of_path(name));
create policy mf_docs_update on storage.objects for update to authenticated
  using (bucket_id = 'docs' and private.mf_member_of_path(name));
create policy mf_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'docs' and private.mf_member_of_path(name));

create policy mf_images_write on storage.objects for insert to authenticated
  with check (bucket_id = 'images' and private.mf_member_of_path(name));
create policy mf_images_update on storage.objects for update to authenticated
  using (bucket_id = 'images' and private.mf_member_of_path(name));
create policy mf_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'images' and private.mf_member_of_path(name));

/* ------------------------------------------------------------ account files */

-- The console uploads to docs/<vendor>/accounts/<company>/<file>, then records it.
create function public.mf_admin_account_file_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); v_co uuid; f public.account_files;
begin
  v_co := private.mf_company_id(c.vendor_id, p->>'company_id');
  if v_co is null then raise exception 'Account not found'; end if;
  if coalesce(p->>'path', '') not like c.vendor_id::text || '/accounts/%' then raise exception 'Upload the file first'; end if;
  insert into public.account_files (vendor_id, company_id, name, path, mime, size, uploaded_by)
  values (c.vendor_id, v_co, left(coalesce(nullif(p->>'name', ''), 'file'), 120), p->>'path',
          coalesce(p->>'mime', ''), private.mf_num(p, 'size')::int, c.actor)
  returning * into f;
  perform private.mf_audit(c.vendor_id, c.actor, 'account_file', p->>'company_id', f.name);
  return jsonb_build_object('ok', true, 'file', jsonb_build_object('id', f.id, 'company_id', p->>'company_id', 'name', f.name,
    'path', f.path, 'mime', f.mime, 'size', f.size, 'uploaded_by', f.uploaded_by, 'ts', f.created_at::text));
end $$;

-- Removes the record and returns the path so the caller deletes the object.
create function public.mf_admin_account_file_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); f public.account_files;
begin
  delete from public.account_files where vendor_id = c.vendor_id and id::text = coalesce(p->>'id', '') returning * into f;
  if f.id is null then raise exception 'File not found'; end if;
  perform private.mf_audit(c.vendor_id, c.actor, 'account_file_delete', '', f.name);
  return jsonb_build_object('ok', true, 'path', f.path);
end $$;

-- The vendor id the console needs to build storage paths.
create function public.mf_vendor_id(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  return jsonb_build_object('ok', true, 'vendor_id', c.vendor_id);
end $$;

revoke execute on function public.mf_admin_account_file_save(jsonb), public.mf_admin_account_file_delete(jsonb), public.mf_vendor_id(jsonb) from public, anon;
grant execute on function public.mf_admin_account_file_save(jsonb), public.mf_admin_account_file_delete(jsonb), public.mf_vendor_id(jsonb) to authenticated;
