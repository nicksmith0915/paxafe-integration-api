/**
 * GET /api/health
 *
 * Deliberately unauthenticated so uptime monitors can reach it, and deliberately
 * shallow: it verifies the database round-trips, which is the only dependency
 * whose failure the API cannot work around. Returns 503 when degraded so a
 * monitor can alert on status code alone.
 *
 * Because it is public, it reports *whether* the database is reachable and
 * never *why* not. A driver error names hosts, ports, poolers and
 * authentication failures -- useful to an operator, and to anyone mapping the
 * infrastructure. The detail goes to the logs, which only operators can read.
 */

import { sql } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { describeDbError } from '@/lib/db/errors';
import { logger } from '@/lib/http/logger';

interface Check {
  status: 'ok' | 'error';
  latency_ms: number;
}

export async function GET(): Promise<Response> {
  const database = await checkDatabase();
  const healthy = database.status === 'ok';

  return Response.json(
    {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: { database },
    },
    {
      status: healthy ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    },
  );
}

async function checkDatabase(): Promise<Check> {
  const startedAt = Date.now();
  try {
    await getDb().execute(sql`select 1`);
    return { status: 'ok', latency_ms: Date.now() - startedAt };
  } catch (error) {
    logger.error('health check failed', {
      event: 'health.database_error',
      error: describeDbError(error),
    });
    return { status: 'error', latency_ms: Date.now() - startedAt };
  }
}
