import { describe, expect, it } from 'vitest';

import { extractApiKey, isValidApiKey } from '@/lib/http/auth';

const KEYS = ['px_live_key_one', 'px_live_key_two'];

describe('isValidApiKey', () => {
  it('accepts any configured key, so keys can be rotated without downtime', () => {
    expect(isValidApiKey('px_live_key_one', KEYS)).toBe(true);
    expect(isValidApiKey('px_live_key_two', KEYS)).toBe(true);
  });

  it('rejects an unknown, empty or absent key', () => {
    expect(isValidApiKey('nope', KEYS)).toBe(false);
    expect(isValidApiKey('', KEYS)).toBe(false);
    expect(isValidApiKey(null, KEYS)).toBe(false);
  });

  it('rejects a prefix of a valid key', () => {
    expect(isValidApiKey('px_live_key_on', KEYS)).toBe(false);
  });

  it('rejects everything when no keys are configured', () => {
    expect(isValidApiKey('anything', [])).toBe(false);
  });
});

describe('extractApiKey', () => {
  it('reads the X-API-Key header', () => {
    expect(extractApiKey(new Headers({ 'x-api-key': 'abc' }))).toBe('abc');
  });

  it('accepts a bearer token as an alternative', () => {
    expect(extractApiKey(new Headers({ authorization: 'Bearer abc' }))).toBe('abc');
    expect(extractApiKey(new Headers({ authorization: 'bearer abc' }))).toBe('abc');
  });

  it('trims surrounding whitespace', () => {
    expect(extractApiKey(new Headers({ 'x-api-key': '  abc  ' }))).toBe('abc');
  });

  it('returns null when no credential is present', () => {
    expect(extractApiKey(new Headers())).toBeNull();
    expect(extractApiKey(new Headers({ authorization: 'Basic xyz' }))).toBeNull();
    expect(extractApiKey(new Headers({ 'x-api-key': '   ' }))).toBeNull();
  });
});
