/**
 * Provision a supplier tenant.
 *
 *   pnpm db:seed                       # demo tenant, fixed dev credentials
 *   pnpm db:seed -- --slug acme --name "Acme Merch" --admin roger@acme.com
 *
 * Prints the API token and master key once. They are stored hashed, so a lost
 * token is reprovisioned, never recovered.
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '../src/generated/prisma/index.js';
import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';

const prisma = new PrismaClient();

const sha256 = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

async function main(): Promise<void> {
  const slug = arg('slug', 'demo');
  const name = arg('name', 'Demo Merch Co');
  const adminEmail = arg('admin', 'admin@demo.test').toLowerCase();
  const isDev = slug === 'demo';

  // The demo tenant gets fixed credentials so local runs are reproducible.
  // Anything else gets real random ones.
  const apiToken = isDev ? 'mf-demo-token' : `mf_${randomBytes(21).toString('base64url')}`;
  const masterKey = isDev ? 'admin2026' : `mfm_${randomBytes(18).toString('base64url')}`;
  const adminPass = isDev ? 'demo-password-1' : randomBytes(12).toString('base64url');

  const existing = await prisma.tenant.findUnique({ where: { slug } });
  if (existing) {
    console.log(`Tenant "${slug}" already exists (${existing.id}). Nothing to do.`);
    return;
  }

  const tenant = await prisma.tenant.create({
    data: {
      slug,
      name,
      apiTokenHash: sha256(apiToken),
      masterKeyHash: await bcrypt.hash(masterKey, 12),
    },
  });

  // Everything below is tenant-scoped, so it runs with app.tenant_id set --
  // the same path the API uses, which means the seed also exercises RLS.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenant.id}'`);
    await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: adminEmail,
        name: 'Administrator',
        passHash: await bcrypt.hash(adminPass, 12),
        role: 'admin',
        active: true,
      },
    });
    await tx.setting.createMany({
      data: [
        { tenantId: tenant.id, key: 'app_name', value: name },
        { tenantId: tenant.id, key: 'co_name', value: name },
      ],
    });
  });

  console.log(`
Tenant provisioned
------------------
  slug        ${slug}
  id          ${tenant.id}
  API token   ${apiToken}
  master key  ${masterKey}
  admin       ${adminEmail} / ${adminPass}

Store these now — only hashes are kept.
`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
