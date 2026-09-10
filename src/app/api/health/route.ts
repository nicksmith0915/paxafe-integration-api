/**
 * GET /api/health
 *
 * Deliberately unauthenticated so uptime monitors can reach it, and deliberately
 * shallow: it verifies the database round-trips, which is the only dependency
 * whose failure the API cannot work around. Returns 503 when degraded so a
 * monitor can alert on status code alone.
 */

import { sql } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { logger } from '@/lib/http/logger';

interface Check {
  status: 'ok' | 'error';
  latency_ms?: number;
  error?: string;
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
    const message = describeError(error);
    logger.error('health check failed', { event: 'health.database_error', error: message });
    return { status: 'error', latency_ms: Date.now() - startedAt, error: message };
  }
}

/**
 * Driver errors wrap the useful part: the outer message is "Failed query:
 * select 1", while the cause carries ECONNREFUSED, a DNS failure or an auth
 * rejection -- which is the only part an operator can act on.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : null;
  const base = error.message.split(/\r?\n/)[0].trim();
  return detail ? `${base}: ${detail}` : base;
}
