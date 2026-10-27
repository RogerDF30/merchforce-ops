-- Replacing an image (upload with upsert) needs a SELECT policy as well as
-- INSERT/UPDATE. The public URL never consults RLS, so this only lets a
-- vendor's own members overwrite their images.
create policy mf_images_read on storage.objects for select to authenticated
  using (bucket_id = 'images' and private.mf_member_of_path(name));
