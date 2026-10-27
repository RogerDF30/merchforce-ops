-- Notice wording: 'Review it' for one product, 'Review them' for several.
create or replace function public.mf_me(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); s jsonb; n_review int; n_img int;
begin
  update public.vendor_members set last_login = now() where vendor_id = c.vendor_id and user_id = c.user_id;
  s := private.mf_settings(c.vendor_id);
  select count(*) filter (where review_pending), count(*) filter (where image_error <> '')
    into n_review, n_img from public.products where vendor_id = c.vendor_id;
  return jsonb_build_object('ok', true,
    'user', jsonb_build_object('email', c.email, 'name', c.actor, 'role', c.role),
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
revoke execute on function public.mf_me(jsonb) from public, anon;
grant execute on function public.mf_me(jsonb) to authenticated;
