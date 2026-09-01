/**
 * Merchforce — outbound mail.
 *
 * Everything the app sends goes through sendMail_. By default it is sent by
 * the Merchforce Google account. If the supplier wants notifications to come
 * from THEIR OWN address, they deploy a tiny relay script in their own Google
 * account (generated in Admin → Settings) and paste its URL + shared secret
 * here; Merchforce then POSTs the message to that relay and their account
 * does the sending — their address, their quota, no credentials shared, and
 * they can revoke it any time by deleting the deployment.
 *
 * If the relay is unreachable, over quota, or misconfigured, the message is
 * still sent from the backend account, so a notification is never lost
 * silently. The last relay result is kept in Script Properties (not Settings)
 * so routine sends don't churn the catalog cache.
 */

function relayStatus_() {
  try { return JSON.parse(props_().getProperty('RELAY_LAST') || 'null'); } catch (e) { return null; }
}
function setRelayStatus_(o) {
  try { props_().setProperty('RELAY_LAST', JSON.stringify(o)); } catch (e) {}
}

function sendMail_(to, subject, body, opts) {
  opts = opts || {};
  var s = getSettings_();
  var fromName = s.mail_from_name || s.site_name || APP_NAME;
  var viaRelay = s.mail_mode === 'relay' && s.relay_url && s.relay_secret;

  if (viaRelay) {
    try {
      var res = UrlFetchApp.fetch(s.relay_url, {
        method: 'post',
        contentType: 'text/plain',
        muteHttpExceptions: true,
        followRedirects: true,
        payload: JSON.stringify({
          secret: s.relay_secret, to: to, subject: subject, body: body,
          name: fromName, replyTo: opts.replyTo || ''
        })
      });
      var out = {};
      try { out = JSON.parse(res.getContentText()); } catch (e2) { out = {}; }
      if (out.ok) {
        setRelayStatus_({ ts: String(now_()), ok: true, remaining: out.remaining === undefined ? null : out.remaining });
        return { ok: true, via: 'relay' };
      }
      throw new Error(out.error || ('relay returned HTTP ' + res.getResponseCode()));
    } catch (e) {
      var msg = e.message || String(e);
      setRelayStatus_({ ts: String(now_()), ok: false, error: msg });
      audit_('system', 'mail_relay_fail', to, msg);
      // fall through — better a mail from us than no mail at all
    }
  }

  try {
    MailApp.sendEmail({
      to: to, subject: subject, body: body, name: fromName,
      replyTo: opts.replyTo || undefined
    });
    return { ok: true, via: viaRelay ? 'backend (relay failed)' : 'backend' };
  } catch (e) {
    audit_('system', 'mail_fail', to, String(e.message || e));
    return { ok: false, error: String(e.message || e) };
  }
}

/** Admin: send a test message and report which path carried it. */
function fnAdminMailTest_(p) {
  var s = getSettings_();
  var to = String(p.to || s.notify_email || '').trim();
  if (!to) return err_('No address to test — set the notification email first');
  var r = sendMail_(to,
    '[' + (s.site_name || APP_NAME) + '] Test notification',
    'This is a test from the ' + (s.site_name || APP_NAME) + ' admin console.\n\n' +
    'If the sender shown is the supplier\'s own address, the mail relay is working.\n\n' +
    'Sent ' + Utilities.formatDate(now_(), 'Asia/Kolkata', 'd MMM yyyy, h:mm a') + ' IST.',
    { replyTo: p.replyTo || '' });
  audit_(p.actor || 'admin', 'mail_test', to, r.via || r.error);
  return r.ok ? ok_({ to: to, via: r.via, status: relayStatus_() })
              : err_(r.error || 'Send failed');
}
