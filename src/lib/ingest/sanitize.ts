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

/**
 * Deepest nesting accepted. A Tive payload is at most three levels deep
 * (Shipment -> ShipFrom -> Latitude); this is an order of magnitude beyond that.
 */
export const MAX_NESTING_DEPTH = 32;

/**
 * Whether a parsed body nests deeper than `limit`.
 *
 * Iterative on purpose. `JSON.parse` accepts arbitrarily deep input, but every
 * recursive walk afterwards -- NUL sanitisation, schema validation, and the
 * driver's own `JSON.stringify` when storing the raw body -- overflows the stack
 * on it. A 200 KB body of nested brackets, well inside the size limit, was
 * enough to crash the handler with a retryable 500. A recursive depth check
 * would crash on exactly the input it exists to catch.
 */
export function exceedsNestingDepth(value: unknown, limit: number = MAX_NESTING_DEPTH): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    if (depth > limit) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return false;
}
