// Staff accounts for one vendor: adminUsers (list) and adminUserSave (create,
// rename, change role, deactivate, set a password). Vendor admins only.
import { asCaller, asService, cors, fail, reply } from '../_shared/http.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail('Bad JSON'); }

  if (body.action === 'platformVendorCreate') return reply(await platformVendorCreate(req, body).catch((e) => ({ ok: false, error: e.message })));
  if (body.action === 'platformAdminSave') return reply(await platformAdminSave(req, body).catch((e) => ({ ok: false, error: e.message })));

  // Is the caller an admin of this vendor? mf_admin_users raises if not.
  const me = await asCaller(req).rpc('mf_admin_users', { p: { vendor: body.vendor } });
  if (me.error) return fail(me.error.message);
  if (body.action === 'adminUsers') return reply(me.data);
  if (body.action !== 'adminUserSave') return fail('Unknown action: ' + body.action);

  const d = body.user ?? {};
  const email = String(d.email ?? '').toLowerCase().trim();
  if (!email) return fail('Email required');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Invalid email');
  const password = d.password ? String(d.password) : '';
  if (password && password.length < 10) return fail('Password must be 10+ characters');

  const svc = asService();
  const vendorId = me.data.vendor_id;
  const look = await svc.rpc('mf_service_user_lookup', { p: { email, vendor_id: vendorId } });
  if (look.error) return fail(look.error.message);

  if (!look.data.user_id) {
    if (!password) return fail('Password must be 10+ characters');
    const made = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    if (made.error) return fail(made.error.message);
  } else if (password) {
    // A sign-in shared with another vendor, or CompanyStore's, is not this admin's to reset.
    if (look.data.platform || look.data.other_vendors > 0) {
      return fail('This person also signs in to another Merchforce account, so only they can change their password.');
    }
    const upd = await svc.auth.admin.updateUserById(look.data.user_id, { password });
    if (upd.error) return fail(upd.error.message);
  }

  const patch: Record<string, unknown> = { vendor_id: vendorId, email, actor: me.data.me };
  if (d.name !== undefined) patch.name = d.name;
  if (d.role !== undefined) patch.role = d.role;
  if (d.active !== undefined) patch.active = !!d.active;
  const saved = await svc.rpc('mf_service_member_upsert', { p: patch });
  if (saved.error) return fail(saved.error.message);
  return reply({ ok: true, email });
});

/**
 * CompanyStore creates a vendor and its first admin in one go. The SQL side
 * checks the caller is a platform admin; the sign-in is made here because it
 * needs the Auth admin API.
 */
async function platformVendorCreate(req: Request, b: Record<string, any>) {
  const email = String(b.admin_email ?? '').toLowerCase().trim();
  const password = String(b.admin_password ?? '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter the vendor admin's email");
  const made = await asCaller(req).rpc('mf_platform_vendor_create', { p: { slug: b.slug, name: b.name, notify_email: email } });
  if (made.error) throw new Error(made.error.message);
  const v = made.data.vendor;
  const svc = asService();
  const look = await svc.rpc('mf_service_user_lookup', { p: { email, vendor_id: v.id } });
  if (look.error) throw new Error(look.error.message);
  let created = false;
  if (!look.data.user_id) {
    if (password.length < 10) throw new Error('Password must be 10+ characters');
    const u = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    if (u.error) throw new Error(u.error.message);
    created = true;
  }
  const m = await svc.rpc('mf_service_member_upsert', { p: { vendor_id: v.id, email, name: b.admin_name ?? '', role: 'admin', active: true, actor: 'platform' } });
  if (m.error) throw new Error(m.error.message);
  return { ok: true, vendor: v, admin: { email, created, existing_sign_in: !created } };
}

/** Editors add or change a CompanyStore platform admin (editor or viewer). */
async function platformAdminSave(req: Request, b: Record<string, any>) {
  const me = await asCaller(req).rpc('mf_platform_me', { p: {} });
  if (me.error) throw new Error(me.error.message);
  if (me.data.me.role !== 'editor') throw new Error('Only a platform editor can manage platform admins');
  const email = String(b.email ?? '').toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email');
  const svc = asService();
  const look = await svc.rpc('mf_service_user_lookup', { p: { email, vendor_id: '00000000-0000-0000-0000-000000000000' } });
  if (look.error) throw new Error(look.error.message);
  let created = false;
  if (!look.data.user_id) {
    if (String(b.password ?? '').length < 10) throw new Error('Password must be 10+ characters');
    const u = await svc.auth.admin.createUser({ email, password: String(b.password), email_confirm: true });
    if (u.error) throw new Error(u.error.message);
    created = true;
  }
  const r = await asCaller(req).rpc('mf_platform_admin_save', { p: { email, name: b.name ?? '', role: b.role } });
  if (r.error) throw new Error(r.error.message);
  return { ok: true, email, role: r.data.role, created };
}
