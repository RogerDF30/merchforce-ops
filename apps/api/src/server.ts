import { createApp } from './app.js';
import { env } from './env.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { actionNames } from './lib/dispatch.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(
    `Merchforce API on :${env.PORT} (${env.NODE_ENV}) — ${actionNames().length} actions`,
  );
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} — shutting down`);
  server.close();
  await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
