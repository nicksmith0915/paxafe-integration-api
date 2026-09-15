import { describe, expect, it } from 'vitest';

import { classifyDbError, describeDbError } from '@/lib/db/errors';

/** Drizzle wraps the postgres.js error, which carries the SQLSTATE. */
const wrapped = (code: string, message: string) =>
  new Error('Failed query: insert into "x" values ($1)\nparams: sensitive-value', {
    cause: Object.assign(new Error(message), { code }),
  });

describe('classifyDbError', () => {
  it.each([
    ['22003', 'numeric field overflow'],
    ['22021', 'invalid byte sequence for encoding "UTF8": 0x00'],
    ['22P05', 'unsupported Unicode escape sequence'],
    ['23502', 'null value in column violates not-null constraint'],
    ['23503', 'insert violates foreign key constraint'],
  ])('treats %s as a permanent data error', (code, message) => {
    expect(classifyDbError(wrapped(code, message))).toMatchObject({ sqlstate: code, retryable: false });
  });

  it.each([
    ['08006', 'connection failure'],
    ['40001', 'could not serialize access'],
    ['40P01', 'deadlock detected'],
    ['53300', 'too many connections'],
    ['57P01', 'terminating connection due to administrator command'],
  ])('treats %s as retryable', (code, message) => {
    expect(classifyDbError(wrapped(code, message))).toMatchObject({ sqlstate: code, retryable: true });
  });

  it('treats a network failure with no SQLSTATE as retryable', () => {
    const network = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    expect(classifyDbError(network)).toMatchObject({ sqlstate: null, retryable: true });
  });

  it('does not mistake a five-letter Node error code for a SQLSTATE', () => {
    const pipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(classifyDbError(pipe)).toMatchObject({ sqlstate: null, retryable: true });
  });

  it('defaults an unrecognised failure to retryable, preferring a retry over lost data', () => {
    expect(classifyDbError(new Error('something unexpected'))).toMatchObject({ retryable: true });
    expect(classifyDbError('not even an error')).toMatchObject({ retryable: true });
  });
});

describe('describeDbError', () => {
  it('surfaces the driver cause that the query wrapper hides', () => {
    expect(describeDbError(wrapped('22003', 'numeric field overflow'))).toBe(
      'Failed query: insert into "x" values ($1): numeric field overflow',
    );
  });

  it('keeps bound parameter values out of the description', () => {
    expect(describeDbError(wrapped('22003', 'numeric field overflow'))).not.toContain('sensitive-value');
  });

  it('describes an unwrapped error by its message alone', () => {
    expect(describeDbError(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED');
  });
});
