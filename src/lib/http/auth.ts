/**
 * API key authentication.
 *
 * Tive-style webhook senders authenticate with a static shared secret, so the
 * threat model here is credential leakage and brute force, not session hijack.
 *
 * The comparison is constant-time. Both sides are SHA-256 hashed first, which
 * gives `timingSafeEqual` the equal-length buffers it requires and stops the
 * comparison itself from leaking the key's length. Comparing with `===` would
 * short-circuit on the first differing byte -- a genuine, if slow, oracle.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const API_KEY_HEADER = 'x-api-key';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function isValidApiKey(presented: string | null, allowed: readonly string[]): boolean {
  if (!presented) return false;
  const presentedDigest = digest(presented);

  // Every candidate is checked -- no early exit -- so the time taken does not
  // reveal which key matched or how many keys are configured.
  let matched = false;
  for (const candidate of allowed) {
    if (timingSafeEqual(presentedDigest, digest(candidate))) matched = true;
  }
  return matched;
}

/** Accepts either `X-API-Key: <key>` or `Authorization: Bearer <key>`. */
export function extractApiKey(headers: Headers): string | null {
  const direct = headers.get(API_KEY_HEADER);
  if (direct && direct.trim()) return direct.trim();

  const auth = headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return null;
}
