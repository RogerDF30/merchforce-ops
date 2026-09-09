import { z } from 'zod';
import type { TenantClient } from './prisma.js';
import type { AccessClaims } from './auth.js';

/**
 * The wire contract, unchanged from Apps Script: every call is
 * POST JSON {token, action, ...} and every reply is {ok:true, ...} or
 * {ok:false, error}. Keeping this identical is what lets the existing
 * 3,700-line admin.js keep working while the entire backend is replaced
 * underneath it.
 *
 * Auth tiers, mirroring Api.gs:
 *   public — needs only the tenant's API token
 *   staff  — additionally needs a valid staff session
 *   admin  — additionally needs role 'admin'
 */
export type AuthTier = 'public' | 'staff' | 'admin';

export interface ActionContext {
  tenantId: string;
  db: TenantClient;
  actor: string;
  actorEmail: string;
  role: 'admin' | 'staff' | 'anon';
  claims: AccessClaims | null;
  ip: string;
  /** Set by a handler when it wants a rotated session returned to the client. */
  session?: string;
}

export type Handler<S extends z.ZodTypeAny> = (
  input: z.infer<S>,
  ctx: ActionContext,
) => Promise<Record<string, unknown>>;

export interface ActionDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  tier: AuthTier;
  schema: S;
  handler: Handler<S>;
  /** Skips the tenant transaction — only for actions that resolve tenancy themselves. */
  untenanted?: boolean;
}

const registry = new Map<string, ActionDef>();

export function defineAction<S extends z.ZodTypeAny>(
  name: string,
  def: ActionDef<S>,
): void {
  if (registry.has(name)) {
    throw new Error(`Duplicate action registered: ${name}`);
  }
  registry.set(name, def as unknown as ActionDef);
}

export function getAction(name: string): ActionDef | undefined {
  return registry.get(name);
}

export function actionNames(): string[] {
  return [...registry.keys()].sort();
}

/** Thrown by handlers for an expected, reportable failure. */
export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}
