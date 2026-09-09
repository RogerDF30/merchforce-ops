import type { ActionContext } from './dispatch.js';

/**
 * Append-only trail. The actor is always taken from the verified session in
 * ctx, never from anything the client sent -- the Apps Script version accepted
 * a client-supplied actor on some paths, which made the log unreliable exactly
 * when it mattered.
 */
export async function audit(
  ctx: ActionContext,
  action: string,
  ref?: string,
  detail?: string,
): Promise<void> {
  await ctx.db.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actor: ctx.actor || 'anon',
      action,
      ref: ref ?? null,
      detail: detail ?? null,
      ip: ctx.ip || null,
    },
  });
}
