import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';

/**
 * Replaces StaffAuth.gs. Two changes that matter:
 *
 *  - Passwords move from SHA-256(pass + salt + PEPPER) to bcrypt. The old
 *    scheme is a single fast hash; a leaked Users tab was brute-forceable at
 *    GPU speed. Existing hashes cannot be converted without the plaintext, so
 *    migration re-hashes on next successful login (see verifyLegacy).
 *  - Sessions move from a signed blob the client round-trips to a signed JWT
 *    with a short TTL plus a rotating refresh token stored server side, so a
 *    session can actually be revoked.
 */

export interface AccessClaims {
  sub: string;        // user id
  tid: string;        // tenant id
  email: string;
  name: string;
  role: 'admin' | 'staff';
}

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * The Apps Script scheme, kept only so existing staff can sign in once after
 * the cutover. On success the caller must immediately re-hash with bcrypt and
 * drop the salt. Delete this function once no legacy hashes remain.
 */
export function verifyLegacy(
  plain: string,
  salt: string,
  pepper: string,
  expected: string,
): boolean {
  const actual = createHash('sha256')
    .update(plain + salt + pepper)
    .digest('hex');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    // The algorithm is pinned: without it a token signed with "alg":"none"
    // would be accepted.
    return jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
    }) as AccessClaims;
  } catch {
    return null;
  }
}

/** Returned to the client once; only the hash is stored. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The 28-char bearer on a customer's order page link. */
export function newOrderToken(): string {
  return randomBytes(21).toString('base64url').slice(0, 28);
}

/** Push key for a supplier's sheet connector. Shown once, stored hashed. */
export function newPushKey(): { key: string; hash: string } {
  const key = `mfp_${randomBytes(24).toString('base64url')}`;
  return { key, hash: hashToken(key) };
}
