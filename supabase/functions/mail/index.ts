// Sends the email outbox. Called once a minute by pg_cron (with a shared
// secret, no user token). Each message goes through the vendor's own Gmail
// relay when they have set one up, else Brevo from notifications@merchforce.io
// under the vendor's name, with replies going to the vendor.
import { asService, reply } from '../_shared/http.ts';

const BREVO = 'https://api.brevo.com/v3/smtp/email';
const FROM = Deno.env.get('MAIL_FROM') ?? 'notifications@merchforce.io';

type Msg = { id: number; payload: { to: string; subject: string; body: string; reply_to?: string };
             from_name: string; mail_mode: string; relay_url: string; relay_secret: string };

async function viaRelay(m: Msg): Promise<{ ok: boolean; error?: string; remaining?: number }> {
  try {
    const res = await fetch(m.relay_url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, redirect: 'follow',
      body: JSON.stringify({ secret: m.relay_secret, to: m.payload.to, subject: m.payload.subject,
                             body: m.payload.body, name: m.from_name, replyTo: m.payload.reply_to || '' }),
    });
    const out = await res.json().catch(() => ({}));
    return out.ok ? { ok: true, remaining: out.remaining } : { ok: false, error: out.error || 'relay returned HTTP ' + res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function viaBrevo(m: Msg): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(BREVO, {
    method: 'POST',
    headers: { 'api-key': Deno.env.get('BREVO_API_KEY')!, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: m.from_name, email: FROM },
      to: m.payload.to.split(/[,;]\s*/).filter(Boolean).map((email) => ({ email })),
      ...(m.payload.reply_to ? { replyTo: { email: m.payload.reply_to } } : {}),
      subject: m.payload.subject,
      textContent: m.payload.body,
    }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: 'Brevo ' + res.status + ': ' + (await res.text()).slice(0, 200) };
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('MF_CRON_SECRET')) return reply({ ok: false, error: 'Forbidden' }, 403);
  const svc = asService();
  const batch = await svc.rpc('mf_service_mail_batch', { p: { limit: 50 } });
  if (batch.error) return reply({ ok: false, error: batch.error.message }, 500);
  let sent = 0, failed = 0;
  for (const m of batch.data.messages as Msg[]) {
    let result: { ok: boolean; error?: string }, relay: Record<string, unknown> | undefined;
    if (m.mail_mode === 'off') {                 // test or paused vendors: recorded, never sent
      await svc.rpc('mf_service_mail_done', { p: { id: m.id, ok: true, error: 'skipped: mail is off for this vendor' } });
      continue;
    }
    if (m.mail_mode === 'relay' && m.relay_url && m.relay_secret) {
      const r = await viaRelay(m);
      relay = { ts: new Date().toISOString(), ok: r.ok, ...(r.ok ? { remaining: r.remaining ?? null } : { error: r.error }) };
      // better a mail from Merchforce than no mail at all
      result = r.ok ? r : await viaBrevo(m);
    } else {
      result = await viaBrevo(m);
    }
    await svc.rpc('mf_service_mail_done', { p: { id: m.id, ok: result.ok, error: result.error ?? '', ...(relay ? { relay } : {}) } });
    result.ok ? sent++ : failed++;
  }
  return reply({ ok: true, sent, failed });
});
