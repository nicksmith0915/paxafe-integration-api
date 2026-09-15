import { describe, expect, it } from 'vitest';

import { resolveRequestId } from '@/lib/http/request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it.each(['req-123', 'a1b2c3', 'trace:span.01_x', 'x'.repeat(128)])('honours a well-formed id: %s', (id) => {
    expect(resolveRequestId(new Headers({ 'x-request-id': id }))).toBe(id);
  });

  it.each([
    ['too long', 'x'.repeat(129)],
    ['spaces', 'two words'],
    ['JSON injection', '"},{"level":"error"'],
    ['markup', '<script>'],
  ])('replaces an id containing %s with a generated one', (_label, id) => {
    const resolved = resolveRequestId(new Headers({ 'x-request-id': id }));
    expect(resolved).not.toBe(id);
    expect(resolved).toMatch(UUID);
  });

  it('generates one when none is supplied', () => {
    expect(resolveRequestId(new Headers())).toMatch(UUID);
  });
});
