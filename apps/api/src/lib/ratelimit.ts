import type Redis from 'ioredis';

/**
 * Fixed-window counter in Redis.
 *
 * This exists because the Apps Script backend had no throttle at all on
 * staffLogin: with the API token (which was committed to a public repo) an
 * attacker had an unlimited-rate password oracle against every staff account.
 * Login is limited per IP AND per email, so neither a single noisy source nor
 * a distributed spray against one account gets a free run.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function rateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const redisKey = `rl:${key}`;
  const count = await redis.incr(redisKey);
  if (count === 1) {
    await redis.expire(redisKey, windowSeconds);
  }
  const ttl = await redis.ttl(redisKey);
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
  };
}

/** Cleared on a successful sign-in so honest users are not punished. */
export async function clearRateLimit(redis: Redis, key: string): Promise<void> {
  await redis.del(`rl:${key}`);
}
