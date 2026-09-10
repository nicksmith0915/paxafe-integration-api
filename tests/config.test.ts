/**
 * Configuration is validated at startup so a missing or malformed variable
 * fails loudly on the first request rather than silently producing a service
 * that accepts everything or stores nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getConfig, resetConfigCache } from '@/lib/config';

const ORIGINAL_ENV = { ...process.env };

const VALID = {
  DATABASE_URL: 'postgresql://user:pass@host:6543/postgres',
  API_KEYS: 'key_one',
};

beforeEach(() => {
  resetConfigCache();
  process.env = { ...ORIGINAL_ENV, ...VALID };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetConfigCache();
});

describe('getConfig', () => {
  it('parses a valid environment and applies documented defaults', () => {
    const config = getConfig();
    expect(config.DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(config.API_KEYS).toEqual(['key_one']);
    expect(config.TELEMETRY_MAX_AGE_DAYS).toBe(90);
    expect(config.TELEMETRY_MAX_FUTURE_SKEW_MINUTES).toBe(60);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('splits and trims a comma-separated key list to support rotation', () => {
    process.env.API_KEYS = ' key_one , key_two ,';
    expect(getConfig().API_KEYS).toEqual(['key_one', 'key_two']);
  });

  it('coerces numeric overrides from their string environment form', () => {
    process.env.TELEMETRY_MAX_AGE_DAYS = '7';
    process.env.TELEMETRY_MAX_FUTURE_SKEW_MINUTES = '15';
    const config = getConfig();
    expect(config.TELEMETRY_MAX_AGE_DAYS).toBe(7);
    expect(config.TELEMETRY_MAX_FUTURE_SKEW_MINUTES).toBe(15);
  });

  it('memoises so repeated reads do not re-parse the environment', () => {
    expect(getConfig()).toBe(getConfig());
  });

  it.each([
    ['DATABASE_URL', ''],
    ['API_KEYS', ''],
    ['API_KEYS', ' , , '],
    ['TELEMETRY_MAX_AGE_DAYS', 'not-a-number'],
    ['TELEMETRY_MAX_AGE_DAYS', '-5'],
    ['LOG_LEVEL', 'chatty'],
  ])('rejects an invalid %s (%s)', (key, value) => {
    process.env[key] = value;
    expect(() => getConfig()).toThrow(/Invalid environment configuration/);
  });

  it('names the offending variable in the error', () => {
    delete process.env.DATABASE_URL;
    expect(() => getConfig()).toThrow(/DATABASE_URL/);
  });
});
