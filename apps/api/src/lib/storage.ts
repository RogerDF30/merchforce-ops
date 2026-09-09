import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';

/**
 * Replaces DriveApp. Cloudflare R2 in production, MinIO locally -- both speak
 * the S3 API, so this is the only file that would change if the bucket moved
 * to AWS.
 *
 * Keys are `<visibility>/t/<tenantId>/<kind>/<uuid><ext>`.
 *
 * Visibility leads, because it is the only shape a bucket policy can actually
 * enforce. Product images must be anonymously readable (they are embedded in
 * emailed PDFs, where a presigned URL would expire), while account documents,
 * PIs and POs must not be. A layout of `t/<tenantId>/<kind>/...` cannot express
 * that: granting anonymous read needs a literal prefix, and a per-tenant
 * images path would need a wildcard in the middle of one. Grouping by
 * visibility first makes the policy exactly two rules -- everything under
 * `public/` is readable, everything else is not.
 *
 * The tenant id still follows, so one supplier's objects remain a single prefix
 * to export, audit or delete.
 */
export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

export type ObjectKind = 'images' | 'accounts' | 'pi' | 'po' | 'decks' | 'exports';

/**
 * Which kinds are anonymously readable. Only product imagery: everything else
 * is a customer document and is served through a short-lived presigned URL.
 */
const PUBLIC_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>(['images']);

export function isPublicKind(kind: ObjectKind): boolean {
  return PUBLIC_KINDS.has(kind);
}

/** Anything not on this list is stored but never served inline. */
const INLINE_SAFE = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

export function buildKey(
  tenantId: string,
  kind: ObjectKind,
  filename: string,
): string {
  const ext = extname(filename).toLowerCase().slice(0, 12);
  const scope = isPublicKind(kind) ? 'public' : 'private';
  return `${scope}/t/${tenantId}/${kind}/${randomUUID()}${ext}`;
}

export async function putObject(opts: {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType?: string;
}): Promise<string> {
  const type = opts.contentType ?? 'application/octet-stream';
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: opts.key,
      Body: opts.body,
      ContentType: type,
      // A file someone uploaded is never rendered in the browser unless its
      // type is on the inline-safe list -- otherwise an uploaded .html would
      // execute on our origin.
      ContentDisposition: INLINE_SAFE.has(type) ? 'inline' : 'attachment',
    }),
  );
  return opts.key;
}

/**
 * Short-lived read URL. Objects are private in the bucket: nothing is served
 * by a permanent public link the way a shared Drive file was, so a URL that
 * leaks stops working within the hour.
 */
export async function presignGet(key: string, expiresIn = 3600): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    { expiresIn },
  );
}

/** Lets the browser upload straight to R2 without the bytes crossing the API. */
export async function presignPut(opts: {
  key: string;
  contentType: string;
  expiresIn?: number;
}): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: opts.key,
      ContentType: opts.contentType,
    }),
    { expiresIn: opts.expiresIn ?? 900 },
  );
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

/**
 * Guard for every key that arrives from a client. Without it, a request could
 * name another tenant's prefix and read their files through our credentials.
 */
export function assertKeyBelongsTo(tenantId: string, key: string): void {
  if (
    !key.startsWith(`public/t/${tenantId}/`) &&
    !key.startsWith(`private/t/${tenantId}/`)
  ) {
    throw new Error('Object key does not belong to this tenant');
  }
}
