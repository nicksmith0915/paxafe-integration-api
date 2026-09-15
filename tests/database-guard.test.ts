import { describe, expect, it } from 'vitest';

import { databaseIdentity, isLocalDatabase, refusalReason } from './database-guard';

const PRODUCTION = 'postgresql://postgres.ref:secret@aws-0-us-west-2.pooler.supabase.com:6543/postgres';

describe('refusalReason', () => {
  it('refuses the application database', () => {
    expect(refusalReason(PRODUCTION, [PRODUCTION])).toMatch(/Refusing to run/);
  });

  it('cannot be bypassed with a query parameter or different password', () => {
    const variant = 'postgresql://postgres.ref:other@AWS-0-US-WEST-2.pooler.supabase.com:6543/postgres?sslmode=require';
    expect(refusalReason(variant, [PRODUCTION])).toMatch(/Refusing to run/);
  });

  it('allows a different remote database', () => {
    const scratch = 'postgresql://postgres.ref:secret@aws-0-us-west-2.pooler.supabase.com:6543/pxtest';
    expect(refusalReason(scratch, [PRODUCTION])).toBeNull();
  });

  it('always allows a local database, as CI uses one for both roles', () => {
    const local = 'postgresql://postgres:postgres@localhost:5432/pxtest';
    expect(refusalReason(local, [local])).toBeNull();
  });

  it('refuses an unparseable connection string', () => {
    expect(refusalReason('not a url', [])).toMatch(/not a valid connection string/);
  });
});

describe('databaseIdentity', () => {
  it('fills in the default port so explicit and implicit 5432 match', () => {
    expect(databaseIdentity('postgresql://u:p@db.example.com/app')).toBe(
      databaseIdentity('postgresql://u:x@db.example.com:5432/app'),
    );
  });
});

describe('isLocalDatabase', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('treats %s as local', (host) => {
    expect(isLocalDatabase(`postgresql://u:p@${host}:5432/db`)).toBe(true);
  });

  it('does not treat a hostname merely containing "localhost" as local', () => {
    expect(isLocalDatabase('postgresql://u:p@localhost.attacker.example:5432/db')).toBe(false);
  });
});
