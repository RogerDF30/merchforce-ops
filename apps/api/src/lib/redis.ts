import Redis from 'ioredis';
import { env } from '../env.js';

/** One connection for rate limiting and caching. Queues get their own. */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

redis.on('error', (err) => {
  // Logged, not thrown: a Redis blip should degrade rate limiting, not take
  // the API down. Callers treat a failed limit check as "allow".
  console.error('[redis]', err.message);
});
