// Shared bits for Merchforce edge functions: CORS, JSON replies, clients.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

/** Errors go back as {ok:false, error}, the shape the console already handles. */
export function fail(error: string): Response {
  return reply({ ok: false, error });
}

const URL = Deno.env.get('SUPABASE_URL')!;

/** Acts as the person calling: every check and RLS rule applies. */
export function asCaller(req: Request): SupabaseClient {
  return createClient(URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  });
}

/** Service role: only after the caller has been checked. */
export function asService(): SupabaseClient {
  return createClient(URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
}
