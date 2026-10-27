-- Merchforce on Supabase — sending the email outbox.
--
-- Actions queue mail in private.outbox inside their own transaction. Once a
-- minute, if anything is waiting, pg_cron calls the 'mail' edge function,
-- which claims a batch, sends each message through the vendor's own Gmail
-- relay (if set) or Brevo, and reports back. A message is retried up to five
-- times; the last error is kept on the row.

alter table public.vendor_secrets add column relay_last jsonb;

-- Claim up to n unsent messages. SKIP LOCKED: two overlapping runs never send twice.
create function public.mf_service_mail_batch(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare out jsonb;
begin
  with picked as (
    select o.id from private.outbox o
     where o.kind = 'mail' and o.sent_at is null and o.attempts < 5
     order by o.id limit greatest(1, least(coalesce((p->>'limit')::int, 50), 200))
     for update skip locked),
  bumped as (
    update private.outbox o set attempts = o.attempts + 1 from picked where o.id = picked.id
    returning o.id, o.vendor_id, o.payload)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'payload', b.payload,
      'from_name', coalesce(nullif(s->>'mail_from_name', ''), nullif(s->>'site_name', ''), nullif(s->>'co_name', ''), 'Merchforce'),
      'mail_mode', s->>'mail_mode', 'relay_url', s->>'relay_url',
      'relay_secret', (select vs.relay_secret from public.vendor_secrets vs where vs.vendor_id = b.vendor_id),
      'vendor_id', b.vendor_id) order by b.id), '[]'::jsonb) into out
  from bumped b cross join lateral (select private.mf_settings(b.vendor_id) as s) x;
  return jsonb_build_object('ok', true, 'messages', out);
end $$;

-- Report one message's outcome; relay results are kept for the Settings screen.
create function public.mf_service_mail_done(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  update private.outbox set
    sent_at = case when (p->>'ok')::boolean then now() end,
    error = left(coalesce(p->>'error', ''), 500)
  where id = (p->>'id')::bigint returning vendor_id into v;
  if p ? 'relay' and v is not null then
    update public.vendor_secrets set relay_last = p->'relay' where vendor_id = v;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Admin: send a test message and see which path carried it (Settings → Mail).
create function public.mf_admin_mail_test(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p, true); v_to text := trim(coalesce(nullif(p->>'to', ''), private.mf_settings(c.vendor_id)->>'notify_email', ''));
begin
  if v_to = '' then raise exception 'No address to test — set the notification email first'; end if;
  perform private.mf_mail(c.vendor_id, v_to, '[' || private.mf_site(c.vendor_id) || '] Test notification',
    'This is a test from ' || private.mf_site(c.vendor_id) || E'.\n\n' ||
    E'If the sender shown is your own address, your mail relay is working.\n\n' ||
    'Sent ' || to_char(now() at time zone 'Asia/Kolkata', 'FMDD Mon YYYY, FMHH12:MI am') || ' IST.', p->>'replyTo');
  perform private.mf_audit(c.vendor_id, c.actor, 'mail_test', v_to);
  return jsonb_build_object('ok', true, 'queued', true, 'to', v_to);
end $$;

-- Settings now report the last relay result, as the Apps Script version did.
create or replace function public.mf_admin_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.mf_ctx := private.mf_ctx(p, true); patch jsonb := coalesce(p->'save', '{}'::jsonb); sec public.vendor_secrets;
begin
  if patch ? 'relay_secret' then
    insert into public.vendor_secrets (vendor_id, relay_secret) values (c.vendor_id, coalesce(patch->>'relay_secret', ''))
    on conflict (vendor_id) do update set relay_secret = excluded.relay_secret;
    patch := patch - 'relay_secret';
  end if;
  if patch <> '{}'::jsonb then
    select coalesce(jsonb_object_agg(key, to_jsonb(value)), '{}'::jsonb) into patch
      from jsonb_each_text(patch) where private.mf_default_settings() ? key;
    insert into public.vendor_settings (vendor_id, settings) values (c.vendor_id, patch)
    on conflict (vendor_id) do update set settings = public.vendor_settings.settings || excluded.settings, updated_at = now();
    perform private.mf_audit(c.vendor_id, c.actor, 'settings_save', '', (select string_agg(k, ', ') from jsonb_object_keys(patch) k));
  end if;
  select * into sec from public.vendor_secrets s where s.vendor_id = c.vendor_id;
  return jsonb_build_object('ok', true,
    'settings', private.mf_settings(c.vendor_id) || jsonb_build_object('relay_secret', coalesce(sec.relay_secret, '')),
    'relay_status', sec.relay_last);
end $$;

revoke execute on function public.mf_service_mail_batch(jsonb), public.mf_service_mail_done(jsonb), public.mf_admin_mail_test(jsonb) from public, anon, authenticated;
grant execute on function public.mf_service_mail_batch(jsonb), public.mf_service_mail_done(jsonb) to service_role;
grant execute on function public.mf_admin_mail_test(jsonb), public.mf_admin_settings(jsonb) to authenticated;

-- Once a minute, only when mail is waiting. The function URL and the shared
-- secret live in Vault (set outside migrations, so no secret is committed).
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net')
     and exists (select 1 from pg_namespace where nspname = 'cron') then
    create extension if not exists pg_net;
    perform cron.schedule('mf-mail-sender', '* * * * *', $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'mf_functions_url') || '/mail',
        headers := jsonb_build_object('Content-Type', 'application/json',
                     'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mf_cron_secret')),
        body := '{}'::jsonb)
      where exists (select 1 from private.outbox where kind = 'mail' and sent_at is null and attempts < 5)
    $job$);
  end if;
end $$;
