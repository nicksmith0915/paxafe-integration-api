/**
 * Pre-persistence sanitisation of the raw request body.
 *
 * Runs before the raw payload is stored, because the raw payload is the audit
 * trail: anything that stops it being written means the reading leaves no trace
 * at all, which is the one outcome the raw-payload-first design exists to rule
 * out.
 */

import type { FieldIssue } from './errors';

/**
 * Postgres cannot store U+0000 in `text` or `jsonb`; the insert fails outright
 * (SQLSTATE 22P05 / 22021). JSON permits it, so a single NUL anywhere in a
 * payload would otherwise make the entire request unstorable.
 *
 * NULs are replaced with U+FFFD, the Unicode replacement character, rather than
 * silently removed: the stored value visibly shows that something was there, so
 * a corrupted device name cannot pass for a legitimate one. Keys are sanitised
 * as well as values, since either can carry the character.
 */
export const NUL = String.fromCharCode(0x0000);
export const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

export function replaceNulBytes(input: unknown): { value: unknown; replaced: boolean } {
  let replaced = false;

  const clean = (text: string): string => {
    if (!text.includes(NUL)) return text;
    replaced = true;
    return text.split(NUL).join(REPLACEMENT_CHARACTER);
  };

  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') return clean(node);
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[clean(key)] = visit(child);
      return out;
    }
    return node;
  };

  const value = visit(input);
  return { value, replaced };
}

/**
 * A Tive webhook carries exactly one reading as a JSON object. Anything else is
 * valid JSON but not a payload, and deserves a message that says what actually
 * went wrong rather than a generic type error at "(root)".
 */
export function payloadShapeIssue(body: unknown): FieldIssue | null {
  if (Array.isArray(body)) {
    return {
      path: '(root)',
      message:
        'Expected a single telemetry object but received an array. Batches are not supported; send one reading per request.',
    };
  }
  if (body === null || typeof body !== 'object') {
    return {
      path: '(root)',
      message: `Expected a telemetry object but received ${body === null ? 'null' : typeof body}.`,
    };
  }
  return null;
}
