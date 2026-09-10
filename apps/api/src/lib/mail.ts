import { env } from '../env.js';
import type { TenantClient } from './prisma.js';
import { getSettings } from './settings.js';

/**
 * Outbound mail via Resend.
 *
 * Each supplier sends from their OWN domain: they verify it in Resend once, set
 * mail_from_email in Settings, and their customers see mail from them rather
 * than from us. That is the whole point on a multi-supplier platform -- a
 * proforma that arrives from a stranger's domain does not get paid.
 *
 * Until a tenant has done that, mail falls back to the platform address with
 * their name on it and reply-to pointing at them. The Apps Script version had
 * the same shape: a relay in the supplier's own Google account, falling back to
 * the Merchforce account, because a notification that silently vanishes is
 * worse than one from the wrong address.
 */

export interface MailResult {
  ok: boolean;
  id?: string;
  from: string;
  via: 'tenant-domain' | 'platform' | 'none';
  error?: string;
}

export interface SendOptions {
  to: string | string[];
  subject: string;
  text: string;
  replyTo?: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function sendMail(
  db: TenantClient,
  tenantId: string,
  opts: SendOptions,
): Promise<MailResult> {
  const recipients = (Array.isArray(opts.to) ? opts.to : [opts.to])
    .map((t) => t.trim())
    .filter((t) => EMAIL.test(t));
  if (!recipients.length) {
    return { ok: false, from: '', via: 'none', error: 'No valid recipient' };
  }

  const s = await getSettings(db, tenantId);
  const fromName = s.mail_from_name || s.co_name || s.site_name || 'Merchforce';
  const tenantFrom = (s.mail_from_email ?? '').trim();

  const useTenant = EMAIL.test(tenantFrom);
  const address = useTenant ? tenantFrom : env.MAIL_FALLBACK_FROM;
  // The display name is the supplier's either way, so even a fallback send
  // reads as being from them.
  const from = `${fromName.replace(/["\\]/g, '')} <${address}>`;
  const via = useTenant ? 'tenant-domain' : 'platform';

  if (!env.RESEND_API_KEY) {
    return { ok: false, from, via, error: 'RESEND_API_KEY is not set' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: recipients,
        subject: opts.subject,
        text: opts.text,
        // Replies go to the person who should answer them, not to the sender.
        ...(opts.replyTo && EMAIL.test(opts.replyTo)
          ? { reply_to: opts.replyTo }
          : {}),
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };

    if (!res.ok) {
      // The common failure is a from-address on an unverified domain, and the
      // message says so -- worth surfacing verbatim rather than flattening it.
      return {
        ok: false, from, via,
        error: body.message || `Resend returned HTTP ${res.status}`,
      };
    }
    return { ok: true, id: body.id ?? '', from, via };
  } catch (err) {
    return {
      ok: false, from, via,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fire-and-forget for notifications that accompany an action.
 *
 * A failed notification must not roll back the thing it was notifying about:
 * an order whose confirmation email bounced is still a confirmed order. The
 * failure is recorded instead, so it is visible rather than lost.
 */
export async function notify(
  db: TenantClient,
  tenantId: string,
  actor: string,
  opts: SendOptions,
): Promise<void> {
  let result: MailResult;
  try {
    result = await sendMail(db, tenantId, opts);
  } catch (err) {
    result = {
      ok: false, from: '', via: 'none',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!result.ok) {
    await db.auditLog
      .create({
        data: {
          tenantId,
          actor: 'system',
          action: 'mail_fail',
          ref: Array.isArray(opts.to) ? opts.to.join(', ') : opts.to,
          detail: `${opts.subject} — ${result.error ?? 'unknown error'}`,
        },
      })
      .catch(() => {});
    return;
  }

  await db.setting
    .upsert({
      where: { tenantId_key: { tenantId, key: 'relay_last' } },
      create: {
        tenantId, key: 'relay_last',
        value: JSON.stringify({ ts: new Date().toISOString(), ok: true, via: result.via }),
      },
      update: {
        value: JSON.stringify({ ts: new Date().toISOString(), ok: true, via: result.via }),
      },
    })
    .catch(() => {});
  void actor;
}
