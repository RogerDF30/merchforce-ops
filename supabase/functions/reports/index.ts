// Analytics for the console: the original calculations over this vendor's rows.
import { asCaller, cors, fail, reply } from '../_shared/http.ts';
import { analytics } from '../_shared/analytics.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return fail('Bad JSON'); }
  if (b.action !== 'adminAnalytics') return fail('Unknown action: ' + b.action);
  const data = await asCaller(req).rpc('mf_admin_analytics_data', { p: { vendor: b.vendor } });   // checks membership
  if (data.error) return fail(data.error.message);
  try { return reply(analytics(b, data.data)); }
  catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
});
