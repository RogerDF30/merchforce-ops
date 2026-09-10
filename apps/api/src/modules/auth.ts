import { z } from 'zod';
import { ActionError, defineAction } from '../lib/dispatch.js';
import { audit } from '../lib/audit.js';
import { getPublicSettings } from '../lib/settings.js';
import { redis } from '../lib/redis.js';
import { clearRateLimit, rateLimit } from '../lib/ratelimit.js';
import {
  hashPassword, signAccessToken, verifyLegacy, verifyPassword,
} from '../lib/auth.js';
import { env } from '../env.js';

const MIN_PASSWORD = 10;

/** Mirrors relayStatus_: the last outbound-mail relay result, or null. */
async function relayStatus(
  db: Parameters<typeof getPublicSettings>[0],
  tenantId: string,
): Promise<unknown> {
  const row = await db.setting.findUnique({
    where: { tenantId_key: { tenantId, key: 'relay_last' } },
  });
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function sessionMinutes(
  db: Parameters<typeof getPublicSettings>[0],
  tenantId: string,
): Promise<number> {
  const s = await getPublicSettings(db, tenantId);
  const n = Number(s.session_minutes);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

// ---------------------------------------------------------------------------

defineAction('staffLogin', {
  tier: 'public',
  schema: z.object({
    email: z.string().trim().toLowerCase().min(1, 'Email and password are required'),
    password: z.string().min(1, 'Email and password are required'),
  }),
  async handler(input, ctx) {
    // Two limits, applied differently on purpose.
    //
    // Per-IP is a HARD block, checked before any work: bcrypt at cost 12 is
    // expensive, so an unauthenticated caller must not be able to make us run
    // it indefinitely.
    //
    // Per-email is a SOFT block that only rejects failures -- a correct
    // password always gets through. A hard per-email limit would let anyone
    // lock a named colleague out of their own account by spraying eight wrong
    // guesses, turning a brute-force defence into a denial-of-service tool.
    // A brute-forcer, by definition, does not have the correct password, so
    // this costs nothing against the attack it is there to stop.
    const emailKey = `login:email:${ctx.tenantId}:${input.email}`;
    const perIp = await rateLimit(redis, `login:ip:${ctx.ip}`, 20, 900);
    if (!perIp.allowed) {
      throw new ActionError(
        `Too many sign-in attempts. Try again in ${Math.ceil(perIp.retryAfterSeconds / 60)} minutes.`,
        429,
      );
    }
    const perEmail = await rateLimit(redis, emailKey, 8, 900);

    const user = await ctx.db.user.findUnique({
      where: { tenantId_email: { tenantId: ctx.tenantId, email: input.email } },
    });

    // One message for every failure, so the response never reveals whether an
    // address exists. The reason is recorded in the audit log instead.
    const deny = async (reason: string): Promise<never> => {
      await audit(
        { ...ctx, actor: input.email },
        'login_fail',
        undefined,
        reason,
      );
      // The soft per-email limit is enforced here, on the failure path only.
      if (!perEmail.allowed) {
        throw new ActionError(
          `Too many sign-in attempts for this account. Try again in ${Math.ceil(perEmail.retryAfterSeconds / 60)} minutes.`,
          429,
        );
      }
      throw new ActionError('Invalid email or password', 401);
    };

    if (!user) return deny('no such user');
    if (!user.active) return deny('disabled');

    if (user.passwordLegacy) {
      // A migrated account still carries its Apps Script hash. Verify against
      // that once, then replace it with bcrypt and drop the salt, so the old
      // scheme survives exactly one sign-in per person.
      if (!env.LEGACY_PEPPER) {
        await audit(
          { ...ctx, actor: input.email }, 'login_fail', undefined,
          'legacy password but LEGACY_PEPPER is not set',
        );
        throw new ActionError(
          'This account needs its password reset — ask an admin.', 401,
        );
      }
      const ok = verifyLegacy(
        input.password, user.legacySalt ?? '', env.LEGACY_PEPPER, user.passHash,
      );
      if (!ok) return deny('bad password (legacy)');
      await ctx.db.user.update({
        where: { id: user.id },
        data: {
          passHash: await hashPassword(input.password),
          legacySalt: null,
          passwordLegacy: false,
        },
      });
      await audit({ ...ctx, actor: user.name || user.email }, 'password_upgraded');
    } else if (!(await verifyPassword(input.password, user.passHash))) {
      return deny('bad password');
    }

    await clearRateLimit(redis, emailKey);
    await ctx.db.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });
    await audit({ ...ctx, actor: user.name || user.email }, 'login_ok');

    const claims = {
      sub: user.id,
      tid: ctx.tenantId,
      email: user.email,
      name: user.name || user.email,
      role: user.role,
    };

    return {
      session: signAccessToken(claims),
      user: { email: user.email, name: claims.name, role: user.role },
      session_minutes: await sessionMinutes(ctx.db, ctx.tenantId),
      settings: await getPublicSettings(ctx.db, ctx.tenantId),
      relay_status: await relayStatus(ctx.db, ctx.tenantId),
    };
  },
});

defineAction('adminUnlock', {
  tier: 'staff',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    await audit(ctx, 'admin_unlock');
    return {
      settings: await getPublicSettings(ctx.db, ctx.tenantId),
      relay_status: await relayStatus(ctx.db, ctx.tenantId),
      user: { name: ctx.actor, email: ctx.actorEmail, role: ctx.role },
      session_minutes: await sessionMinutes(ctx.db, ctx.tenantId),
    };
  },
});

/** Names for the follow-up-owner picker. Active staff only. */
defineAction('adminStaffList', {
  tier: 'staff',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    const rows = await ctx.db.user.findMany({
      where: { tenantId: ctx.tenantId, active: true },
      select: { email: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
    return {
      staff: rows.map((u) => ({
        email: u.email.toLowerCase(),
        name: u.name || u.email,
        role: u.role,
      })),
    };
  },
});

defineAction('adminUsers', {
  tier: 'admin',
  schema: z.object({}).passthrough(),
  async handler(_input, ctx) {
    const rows = await ctx.db.user.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      users: rows.map((u) => ({
        email: u.email,
        name: u.name,
        role: u.role,
        active: u.active,
        created: u.createdAt.toISOString(),
        last_login: u.lastLogin ? u.lastLogin.toISOString() : '',
      })),
    };
  },
});

defineAction('adminUserSave', {
  tier: 'admin',
  schema: z.object({
    user: z.object({
      email: z.string().trim().toLowerCase().email('A valid email is required'),
      name: z.string().trim().optional(),
      role: z.enum(['admin', 'staff']).optional(),
      active: z.boolean().optional(),
      password: z.string().optional(),
    }),
  }),
  async handler(input, ctx) {
    const d = input.user;
    const existing = await ctx.db.user.findUnique({
      where: { tenantId_email: { tenantId: ctx.tenantId, email: d.email } },
    });

    // An admin editing their own row must not be able to lock themselves out.
    // The console offers both controls on your own account, and the Apps Script
    // version happily applied them.
    const isSelf =
      ctx.actorEmail !== '' && ctx.actorEmail.toLowerCase() === d.email;
    if (isSelf && d.active === false) {
      throw new ActionError('You cannot deactivate your own account');
    }
    if (isSelf && d.role === 'staff') {
      throw new ActionError('You cannot remove your own admin role');
    }

    // Nor may the last admin be removed by someone else, which would leave the
    // tenant reachable only through the master recovery key.
    if (existing && (d.active === false || d.role === 'staff')) {
      const admins = await ctx.db.user.count({
        where: { tenantId: ctx.tenantId, role: 'admin', active: true },
      });
      if (admins <= 1 && existing.role === 'admin' && existing.active) {
        throw new ActionError('This is the only admin. Promote someone else first.');
      }
    }

    if (existing) {
      const data: Record<string, unknown> = {};
      if (d.name !== undefined) data.name = d.name;
      if (d.role !== undefined) data.role = d.role;
      if (d.active !== undefined) data.active = d.active;
      if (d.password) {
        if (d.password.length < MIN_PASSWORD) {
          throw new ActionError(`Password must be ${MIN_PASSWORD}+ characters`);
        }
        data.passHash = await hashPassword(d.password);
      }
      await ctx.db.user.update({ where: { id: existing.id }, data });
    } else {
      if (!d.password || d.password.length < MIN_PASSWORD) {
        throw new ActionError(`Password must be ${MIN_PASSWORD}+ characters`);
      }
      await ctx.db.user.create({
        data: {
          tenantId: ctx.tenantId,
          email: d.email,
          name: d.name ?? '',
          passHash: await hashPassword(d.password),
          role: d.role ?? 'staff',
          active: d.active ?? true,
        },
      });
    }

    await audit(ctx, 'user_save', d.email);
    return { email: d.email };
  },
});
