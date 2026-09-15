import { describe, expect, it } from 'vitest';

import { NUL, payloadShapeIssue, REPLACEMENT_CHARACTER, replaceNulBytes } from '@/lib/ingest/sanitize';

describe('replaceNulBytes', () => {
  it('replaces NULs in values at any depth, including inside arrays', () => {
    const { value, replaced } = replaceNulBytes({
      DeviceName: `A${NUL}B`,
      Location: { FormattedAddress: `Bronx${NUL}` },
      tags: [`x${NUL}${NUL}y`],
    });
    expect(replaced).toBe(true);
    expect(value).toEqual({
      DeviceName: `A${REPLACEMENT_CHARACTER}B`,
      Location: { FormattedAddress: `Bronx${REPLACEMENT_CHARACTER}` },
      tags: [`x${REPLACEMENT_CHARACTER}${REPLACEMENT_CHARACTER}y`],
    });
  });

  it('replaces NULs in keys, which break jsonb just as values do', () => {
    const { value, replaced } = replaceNulBytes({ [`Device${NUL}Name`]: 'A571992' });
    expect(replaced).toBe(true);
    expect(value).toEqual({ [`Device${REPLACEMENT_CHARACTER}Name`]: 'A571992' });
  });

  it('leaves a clean payload structurally identical and reports nothing replaced', () => {
    const payload = { DeviceId: '863257063350583', Temperature: { Celsius: 10.1 }, flag: true, empty: null };
    const { value, replaced } = replaceNulBytes(payload);
    expect(replaced).toBe(false);
    expect(value).toEqual(payload);
  });

  it('passes non-object bodies through unchanged', () => {
    expect(replaceNulBytes(null)).toEqual({ value: null, replaced: false });
    expect(replaceNulBytes(42)).toEqual({ value: 42, replaced: false });
  });
});

describe('payloadShapeIssue', () => {
  it('accepts a plain object', () => {
    expect(payloadShapeIssue({ DeviceId: '1' })).toBeNull();
  });

  it.each([
    [null, 'received null'],
    ['text', 'received string'],
    [7, 'received number'],
    [true, 'received boolean'],
  ])('rejects %j', (body, expected) => {
    expect(payloadShapeIssue(body)).toMatchObject({ path: '(root)', message: expect.stringContaining(expected) });
  });

  it('names batching as the problem when given an array', () => {
    expect(payloadShapeIssue([{}])?.message).toContain('Batches are not supported');
  });
});
