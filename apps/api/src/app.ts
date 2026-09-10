import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { env } from './env.js';
import { prisma, withTenant } from './lib/prisma.js';
import { hashToken, verifyAccessToken, verifyPassword } from './lib/auth.js';
import { ActionError, getAction, actionNames, type ActionContext } from './lib/dispatch.js';
import './modules/index.js';

/**
 * One endpoint, one protocol -- the same as the Apps Script /exec URL:
 *   POST {token, action, ...}  ->  {ok:true, ...} | {ok:false, error}
 *
 * The console posts Content-Type: text/plain (Apps Script required it to dodge
 * a CORS preflight), so the body is parsed as text and JSON.parsed by hand.
 * Keeping that quirk is what lets the existing frontend talk to this unchanged.
 */
export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : false,
      methods: ['POST', 'GET'],
      maxAge: 86400,
    }),
  );
  app.use(express.text({ type: ['text/plain', 'application/json'], limit: '25mb' }));

  // Matches doGet: a health check and nothing else.
  app.get('/', (_req, res) => {
    res.json({ ok: true, app: 'Merchforce', ts: Date.now() });
  });

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: 'up' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  app.post('/', handle);
  app.post('/exec', handle);

  return app;
}

async function handle(req: Request, res: Response): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(typeof req.body === 'string' ? req.body : '{}');
  } catch {
    res.json({ ok: false, error: 'Bad JSON' });
    return;
  }

  const actionName = String(body.action ?? '');
  const def = getAction(actionName);
  if (!def) {
    res.json({ ok: false, error: `Unknown action: ${actionName}` });
    return;
  }

  const ip = req.ip ?? '';

  // 1. Which supplier is this call for?
  //
  //    Two ways, and the difference matters. `tenant` is a public slug, which
  //    is what a browser console sends: it ships in a JavaScript bundle anyone
  //    can read, so treating it as a secret was always theatre -- the previous
  //    build shipped a real API token in admin.js and it sat in a public repo
  //    for a week. Naming it for what it is stops anyone mistaking it for
  //    protection. Nothing is authorised by it; every admin action still needs
  //    a staff session, and staffLogin is bcrypt behind a rate limit.
  //
  //    `token` stays for server-to-server callers, where a secret can actually
  //    be kept. It is hashed at rest and reaches exactly one tenant.
  const slug = String(body.tenant ?? '').trim().toLowerCase();
  const token = String(body.token ?? '');

  if (!slug && !token) {
    res.json({ ok: false, error: 'No tenant specified' });
    return;
  }

  const tenant = slug
    ? await prisma.tenant.findUnique({
        where: { slug },
        select: { id: true, status: true, masterKeyHash: true },
      })
    : await prisma.tenant.findUnique({
        where: { apiTokenHash: hashToken(token) },
        select: { id: true, status: true, masterKeyHash: true },
      });

  if (!tenant) {
    // Deliberately identical either way: a wrong slug and a wrong token should
    // not be distinguishable, or the reply becomes a way to enumerate tenants.
    res.json({ ok: false, error: 'Bad token' });
    return;
  }
  if (tenant.status !== 'active') {
    res.json({ ok: false, error: 'This account is not active' });
    return;
  }

  try {
    const out = await withTenant(tenant.id, async (db) => {
      const ctx: ActionContext = {
        tenantId: tenant.id,
        db,
        actor: 'anon',
        actorEmail: '',
        role: 'anon',
        claims: null,
        ip,
      };

      // 2. Anything above 'public' needs a staff session, or the master key as
      //    the recovery path -- mirroring Api.gs. The actor is taken from the
      //    verified session, never from what the client claims.
      if (def.tier !== 'public') {
        const claims = body.session ? verifyAccessToken(String(body.session)) : null;
        const masterKey = String(body.adminKey ?? '');

        if (claims && claims.tid === tenant.id) {
          ctx.claims = claims;
          ctx.actor = claims.name || claims.email;
          ctx.actorEmail = claims.email;
          ctx.role = claims.role;
        } else if (
          masterKey &&
          tenant.masterKeyHash &&
          (await verifyPassword(masterKey, tenant.masterKeyHash))
        ) {
          ctx.actor = 'master';
          ctx.role = 'admin';
        } else {
          throw new ActionError(
            body.session
              ? 'Your session has expired. Sign in again.'
              : 'Bad admin key',
            401,
          );
        }

        if (def.tier === 'admin' && ctx.role !== 'admin') {
          throw new ActionError('Only an admin can do that', 403);
        }
      }

      const input = def.schema.parse(body);
      const result = await def.handler(input, ctx);
      return { ok: true, ...result, ...(ctx.session ? { session: ctx.session } : {}) };
    });

    res.json(out);
  } catch (err) {
    if (err instanceof ActionError) {
      res.json({ ok: false, error: err.message });
      return;
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      res.json({
        ok: false,
        error: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid input',
      });
      return;
    }
    // Anything unexpected is logged in full and reported vaguely: an internal
    // message can carry column names, SQL or file paths.
    console.error(`[${actionName}]`, err);
    res.json({ ok: false, error: 'Something went wrong. Try again.' });
  }
}

export { actionNames };
