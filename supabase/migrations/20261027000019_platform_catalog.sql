-- Merchforce on Supabase — CompanyStore's view across vendors.
-- 1. mf_platform_catalog: every vendor's products in one searchable list.
-- 2. mf_me tells the console when the person is a CompanyStore platform admin
--    acting inside a vendor they do not belong to, so it can say so plainly.
--    (Platform admins already act as admin in any vendor; every change they
--    make is recorded under their own email.)

create function public.mf_platform_catalog(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(trim(coalesce(p->>'q', ''))); v_slug text := lower(coalesce(p->>'vendor_slug', ''));
        lim int := least(greatest(coalesce((p->>'limit')::int, 300), 1), 1000);
begin
  if not private.mf_is_platform_admin() then raise exception 'Only a platform admin can do that'; end if;
  return jsonb_build_object('ok', true, 'products', coalesce((
    select jsonb_agg(x order by x->>'vendor', x->>'sku') from (
      select jsonb_build_object(
        'vendor', v.name, 'vendor_slug', v.slug, 'sku', pr.sku, 'name', pr.name,
        'brand', coalesce(b.name, ''), 'category', pr.category, 'image', coalesce(pr.images[1], ''),
        'moq', pr.moq, 'gst_rate', pr.gst_rate, 'hsn', pr.hsn, 'lead_time', pr.lead_time,
        'on_hand', pr.on_hand, 'reserved', pr.reserved, 'atp', private.mf_atp(pr.on_hand, pr.reserved, pr.safety_stock),
        'price', (select t.unit_price from public.price_tiers t where t.product_id = pr.id order by t.min_qty limit 1),
        'visible', pr.visible, 'review_pending', pr.review_pending, 'updated', pr.updated_at) as x
        from public.products pr
        join public.vendors v on v.id = pr.vendor_id
        left join public.brands b on b.id = pr.brand_id
       where (v_slug = '' or v.slug = v_slug)
         and (q = '' or lower(pr.sku || ' ' || pr.name || ' ' || coalesce(b.name, '') || ' ' || pr.category || ' ' || pr.hsn || ' ' || v.name) like '%' || q || '%')
       order by v.name, pr.sku
       limit lim) s), '[]'::jsonb),
    'total', (select count(*) from public.products pr join public.vendors v on v.id = pr.vendor_id where v_slug = '' or v.slug = v_slug));
end $$;

create or replace function public.mf_me(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); s jsonb; n_review int; n_img int; v_member boolean;
begin
  update public.vendor_members set last_login = now() where vendor_id = c.vendor_id and user_id = c.user_id;
  v_member := exists (select 1 from public.vendor_members m where m.vendor_id = c.vendor_id and m.user_id = c.user_id and m.active);
  s := private.mf_settings(c.vendor_id);
  select count(*) filter (where review_pending), count(*) filter (where image_error <> '')
    into n_review, n_img from public.products where vendor_id = c.vendor_id;
  return jsonb_build_object('ok', true,
    'user', jsonb_build_object('email', c.email, 'name', c.actor, 'role', c.role,
                               'platform', private.mf_is_platform_admin(), 'acting_for', not v_member),
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

revoke execute on function public.mf_platform_catalog(jsonb), public.mf_me(jsonb) from public, anon;
grant execute on function public.mf_platform_catalog(jsonb), public.mf_me(jsonb) to authenticated;
