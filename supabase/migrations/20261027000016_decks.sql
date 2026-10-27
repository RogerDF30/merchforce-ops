-- Merchforce on Supabase — product decks (PDF + PPTX). Ports Decks.gs.
-- The files edge function renders and stores them; these functions validate,
-- number, list, send and delete. Files live in docs/<vendor>/decks/<DK-…>/.

create function private.mf_deck_out(d public.decks) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', d.number, 'name', d.name, 'skus', to_jsonb(d.skus),
    'company_id', coalesce((select co.code from public.companies co where co.id = d.company_id), ''), 'company', d.company,
    'pdf_path', d.pdf_path, 'pptx_path', d.pptx_path, 'pdf_url', '', 'pptx_url', '', 'folder_id', '',
    'created_by', d.created_by, 'created', d.created_at::text, 'sent_to', d.sent_to, 'last_sent', coalesce(d.last_sent::text, ''));
$$;

create function public.mf_admin_decks(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p);
begin
  return jsonb_build_object('ok', true, 'decks', coalesce((select jsonb_agg(private.mf_deck_out(d) order by d.created_at desc)
    from public.decks d where d.vendor_id = c.vendor_id and d.pdf_path <> ''), '[]'::jsonb));
end $$;

-- Validate, number the deck, and hand the renderer everything it needs.
create function public.mf_admin_deck_prepare(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c private.mf_ctx := private.mf_ctx(p);
  v_name text := trim(coalesce(p->>'name', ''));
  v_skus text[] := (select coalesce(array_agg(trim(x)), '{}') from jsonb_array_elements_text(coalesce(p->'skus', '[]'::jsonb)) x where trim(x) <> '');
  prods jsonb; v_num text;
begin
  if v_name = '' then raise exception 'Give the deck a name'; end if;
  if coalesce(array_length(v_skus, 1), 0) = 0 then raise exception 'Pick at least one product'; end if;
  if array_length(v_skus, 1) > 40 then raise exception '40 products per deck at most — split it'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'sku', pr.sku, 'name', pr.name, 'brand', coalesce(b.name, ''), 'category', pr.category, 'description', pr.description,
      'specs', (select coalesce(jsonb_agg(trim(x)), '[]'::jsonb) from unnest(string_to_array(pr.specs, '|')) x where trim(x) <> ''),
      'image', coalesce(pr.images[1], ''), 'moq', pr.moq, 'gst', pr.gst_rate, 'hsn', pr.hsn, 'lead_time', pr.lead_time,
      'mrp', coalesce(pr.mrp, 0), 'atp', private.mf_atp(pr.on_hand, pr.reserved, pr.safety_stock),
      'tiers', coalesce((select jsonb_agg(jsonb_build_object('min', t.min_qty, 'price', t.unit_price) order by t.min_qty)
                         from public.price_tiers t where t.product_id = pr.id), '[]'::jsonb)) order by s.ord), '[]'::jsonb)
    into prods
    from unnest(v_skus) with ordinality s(sku, ord)
    join public.products pr on pr.vendor_id = c.vendor_id and upper(pr.sku) = upper(s.sku)
    left join public.brands b on b.id = pr.brand_id;
  if jsonb_array_length(prods) = 0 then raise exception 'None of those SKUs exist'; end if;
  v_num := private.mf_next_number(c.vendor_id, 'deck', 'DK', false);
  insert into public.decks (vendor_id, number, name, skus, company_id, company, created_by)
  values (c.vendor_id, v_num, v_name, (select array_agg(x->>'sku') from jsonb_array_elements(prods) x),
          case when coalesce(p->>'company_id', '') <> '' then private.mf_company_id(c.vendor_id, p->>'company_id') end,
          coalesce(p->>'company', ''), c.actor);
  return jsonb_build_object('ok', true, 'vendor_id', c.vendor_id, 'id', v_num, 'name', v_name, 'company', coalesce(p->>'company', ''),
    'settings', private.mf_settings(c.vendor_id), 'products', prods,
    'missing', array_length(v_skus, 1) - jsonb_array_length(prods));
end $$;

-- After rendering: record the files, or drop the half-made deck if rendering failed.
create function public.mf_service_deck_files(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v uuid := (p->>'vendor_id')::uuid;
begin
  if coalesce(p->>'pdf_path', '') = '' then
    delete from public.decks where vendor_id = v and number = p->>'id';
    return jsonb_build_object('ok', true, 'dropped', true);
  end if;
  update public.decks set pdf_path = p->>'pdf_path', pptx_path = p->>'pptx_path' where vendor_id = v and number = p->>'id';
  perform private.mf_audit(v, coalesce(p->>'actor', 'admin'), 'deck_build', p->>'id', coalesce(p->>'count', '') || ' products');
  return jsonb_build_object('ok', true);
end $$;

-- Email a deck. The files function adds 30-day download links (p.pdf_url, p.pptx_url).
create function public.mf_admin_deck_send(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); d public.decks; s jsonb := private.mf_settings(c.vendor_id); v_to text := trim(coalesce(p->>'to', ''));
begin
  select * into d from public.decks where vendor_id = c.vendor_id and number = p->>'id';
  if d.id is null then raise exception 'Deck not found'; end if;
  if not private.mf_valid_email(v_to) then raise exception 'A valid email address is required'; end if;
  perform private.mf_mail(c.vendor_id, v_to, '[' || private.mf_biz(c.vendor_id) || '] ' || d.name,
    case when coalesce(trim(p->>'message'), '') <> '' then trim(p->>'message') || E'\n\n' else '' end ||
    'Product deck: ' || d.name || E'\nPDF: ' || coalesce(p->>'pdf_url', '') || E'\nPowerPoint: ' || coalesce(p->>'pptx_url', '') ||
    E'\n(The links work for 30 days.)\n\nPrices are in INR, exclusive of GST. Stock is as at the date on the deck.\n\n' ||
    private.mf_biz(c.vendor_id) || case when coalesce(s->>'co_phone', '') <> '' then ' · ' || (s->>'co_phone') else '' end ||
    case when coalesce(s->>'co_email', '') <> '' then ' · ' || (s->>'co_email') else '' end,
    coalesce(nullif(s->>'co_email', ''), s->>'notify_email'));
  update public.decks set sent_to = case when sent_to = '' then v_to else sent_to || ', ' || v_to end, last_sent = now() where id = d.id;
  perform private.mf_audit(c.vendor_id, c.actor, 'deck_send', d.number, v_to);
  return jsonb_build_object('ok', true, 'id', d.number, 'via', 'queued');
end $$;

create function public.mf_admin_deck_delete(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p); d public.decks;
begin
  delete from public.decks where vendor_id = c.vendor_id and number = p->>'id' returning * into d;
  if d.id is null then raise exception 'Deck not found'; end if;
  perform private.mf_audit(c.vendor_id, c.actor, 'deck_delete', d.number);
  return jsonb_build_object('ok', true, 'id', d.number, 'paths', jsonb_build_array(d.pdf_path, d.pptx_path));
end $$;

revoke execute on all functions in schema public, private from public, anon;
grant execute on function public.mf_admin_decks(jsonb), public.mf_admin_deck_prepare(jsonb), public.mf_admin_deck_send(jsonb),
  public.mf_admin_deck_delete(jsonb) to authenticated;
grant execute on function public.mf_service_deck_files(jsonb) to service_role;
revoke execute on function public.mf_service_deck_files(jsonb) from authenticated;
grant execute on function public.mf_order_view(jsonb), public.mf_order_pi_respond(jsonb), public.mf_order_po_upload(jsonb) to anon, authenticated;
grant execute on function private.mf_is_platform_admin(), private.mf_is_member(uuid), private.mf_is_vendor_admin(uuid), private.mf_member_of_path(text) to authenticated;
