import type { TenantClient } from './prisma.js';

/**
 * Settings are key/value rows, as the Settings tab was. DEFAULTS mirrors
 * DEFAULT_SETTINGS in apps-script/Config.gs, so a tenant with no rows behaves
 * exactly like a fresh Apps Script install, and an unknown key is ignored on
 * write rather than silently creating a setting nothing reads.
 */
export const DEFAULTS: Record<string, string> = {
  site_name: 'Merchforce',
  tagline: 'Bulk merchandise, direct from stock',
  app_name: 'Merchforce',
  app_tagline: 'Enquiries, orders, stock and decks in one place',
  app_logo_url: '',
  access_mode: 'open',
  show_stock_numbers: 'badge',
  notify_email: '',
  mail_mode: 'backend',
  mail_from_name: '',
  relay_url: '',
  relay_secret: '',
  low_stock_threshold: '25',
  currency: 'INR',
  co_name: '',
  co_address: '',
  co_state: '',
  co_state_code: '',
  co_gstin: '',
  co_pan: '',
  co_phone: '',
  co_email: '',
  co_bank: '',
  co_terms: '',
  co_logo_url: '',
  co_sign_url: '',
  pi_prefix: 'PI',
  pi_validity_days: '15',
  deck_accent: '#2447F5',
  deck_ink: '#1D1D1F',
  deck_muted: '#6E6E73',
  deck_plate: '#F5F5F7',
  deck_layout: 'compact',
  session_minutes: '30',
  session_days: '30',
  reorder_alert: 'off',
  site_url: '',
  primary_color: '#1a1f36',
  sync_auto: 'off',
  sync_last: '',
};

/** Secrets are never returned to the console. */
const REDACTED = new Set(['relay_secret']);

export async function getSettings(
  db: TenantClient,
  tenantId: string,
): Promise<Record<string, string>> {
  const rows = await db.setting.findMany({ where: { tenantId } });
  const out: Record<string, string> = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function getPublicSettings(
  db: TenantClient,
  tenantId: string,
): Promise<Record<string, string>> {
  const all = await getSettings(db, tenantId);
  for (const k of REDACTED) if (all[k]) all[k] = '********';
  return all;
}

export async function saveSettings(
  db: TenantClient,
  tenantId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([k]) => k in DEFAULTS);
  for (const [key, value] of entries) {
    const v = String(value ?? '');
    // A redacted value coming back from the console means "unchanged", not
    // "set it to literal asterisks".
    if (REDACTED.has(key) && v === '********') continue;
    await db.setting.upsert({
      where: { tenantId_key: { tenantId, key } },
      create: { tenantId, key, value: v },
      update: { value: v },
    });
  }
}

/**
 * "10 Sept 2026, 12:31 pm" in IST.
 *
 * generated_at is printed straight into the Stock and Analytics headers, so it
 * has to arrive pre-formatted: Apps Script sent a display string and the
 * console never parsed it. Returning an ISO timestamp here put a raw
 * 2026-09-10T06:59:19.350Z on screen.
 */
export function displayStamp(d: Date = new Date()): string {
  const date = d.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
  const time = d
    .toLocaleTimeString('en-IN', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
    })
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return `${date}, ${time}`;
}
