/**
 * Database connection.
 *
 * Serverless-specific constraints this file exists to handle:
 *
 *  - Each warm function instance keeps its own pool, and instances scale with
 *    traffic. `max: 1` keeps a burst of concurrent invocations from exhausting
 *    Postgres connections; pooling is Supabase's job, not ours.
 *  - `prepare: false` is required when connecting through Supabase's
 *    transaction-mode pooler (port 6543), which cannot support session-level
 *    prepared statements. Leaving it on produces intermittent
 *    "prepared statement already exists" failures under concurrency -- the kind
 *    that only appear once real traffic arrives.
 *  - The client is cached on `globalThis` so hot reloads in dev and warm starts
 *    in production reuse one pool instead of leaking a new one per module load.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { getConfig } from '@/lib/config';
import * as schema from './schema';

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as {
  __pxSql?: ReturnType<typeof postgres>;
  __pxDb?: DrizzleDb;
};

export function getDb(): DrizzleDb {
  if (globalForDb.__pxDb) return globalForDb.__pxDb;

  const sql = postgres(getConfig().DATABASE_URL, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  const db = drizzle(sql, { schema });
  globalForDb.__pxSql = sql;
  globalForDb.__pxDb = db;
  return db;
}

/** Closes the pool. Used by integration tests; not called in serverless. */
export async function closeDb(): Promise<void> {
  await globalForDb.__pxSql?.end({ timeout: 5 });
  globalForDb.__pxSql = undefined;
  globalForDb.__pxDb = undefined;
}

export type { DrizzleDb };
export { schema };
