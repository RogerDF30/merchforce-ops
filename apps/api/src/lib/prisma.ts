import { PrismaClient } from '../generated/prisma/index.js';
import { env } from '../env.js';

/**
 * One process-wide client. Tenant scoping is NOT done by handing out
 * per-tenant clients -- that would mean a connection pool per supplier.
 * Instead every tenant-scoped unit of work runs inside `withTenant`, which
 * opens a transaction and sets the Postgres GUC the RLS policies read.
 */
export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export type TenantClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Run `fn` with the tenant context set, inside a single transaction.
 *
 * set_local scopes the GUC to this transaction, so a pooled connection cannot
 * carry one supplier's tenant id into the next request -- the failure mode
 * that makes naive RLS worse than none. The id is checked against a UUID
 * pattern first: set_local cannot be parameterised, so the value is
 * interpolated, and only a validated UUID is ever allowed near that string.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) {
    throw new Error(`withTenant: refusing to set a non-UUID tenant id`);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    return fn(tx as unknown as TenantClient);
  });
}

/**
 * For the handful of operations that legitimately precede tenant context:
 * resolving a tenant by slug at login, and looking up a customer order by its
 * own 28-char token. Nothing else should call this.
 */
export async function withoutTenant<T>(
  fn: (client: PrismaClient) => Promise<T>,
): Promise<T> {
  return fn(prisma);
}
