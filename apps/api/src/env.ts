import { z } from 'zod';

/**
 * Fail at boot, not at the first request. Every value the server needs is
 * declared here, so a missing secret is a startup crash with a readable
 * message rather than a 500 three hours into a deploy.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8901),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default('auto'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  S3_PUBLIC_BASE: z.string().url(),

  // HS256 with anything shorter is not worth signing.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Seconds, not "30m": the string form of jsonwebtoken's expiresIn is a
  // template-literal type, so a plain string from the environment never fits it.
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Pepper from the Apps Script install being migrated from. Needed only to
  // verify a migrated password once; can be removed when no account still
  // has password_legacy set.
  LEGACY_PEPPER: z.string().optional(),

  // ---- Mail (Resend) ----
  // Absent in development: sends then report why they did not go, rather than
  // pretending. Required in production.
  RESEND_API_KEY: z.string().optional(),
  // Used when a tenant has not verified their own sending domain yet.
  MAIL_FALLBACK_FROM: z.string().email().default('no-reply@merchforce.app'),
  // Where a customer's order page lives, for links in emails.
  PUBLIC_ORDER_URL: z.string().default(''),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment:\n${issues}`);
}

export const env = parsed.data;
export type Env = typeof env;
