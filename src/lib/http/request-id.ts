import { randomUUID } from 'node:crypto';

/**
 * A caller-supplied correlation id is honoured only if it looks like one. The
 * value is echoed in the response, written to every log line and stored on the
 * raw payload row, so an arbitrary header must not flow into all three.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(headers: Headers): string {
  const supplied = headers.get('x-request-id')?.trim();
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
}
