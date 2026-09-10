/**
 * POST /api/webhook/tive
 *
 * The HTTP boundary, and nothing else: authenticate, read the body, hand it to
 * the pipeline, map the outcome to a status code. All domain logic lives under
 * `src/lib`, which keeps it testable without spinning up a server.
 *
 * Response model is synchronous. At this volume it is the honest choice -- the
 * sender learns whether its payload was actually accepted, and gets real
 * backpressure when the database is unhealthy. The raw-payload-first ordering
 * in the pipeline is the seam where this becomes async if throughput demands it.
 */

import { randomUUID } from 'node:crypto';

import { getConfig } from '@/lib/config';
import { getDb } from '@/lib/db/client';
import { createDrizzleRepository } from '@/lib/db/repository';
import { IngestError } from '@/lib/ingest/errors';
import { ingestTivePayload } from '@/lib/ingest/pipeline';
import { extractApiKey, isValidApiKey } from '@/lib/http/auth';
import { logger } from '@/lib/http/logger';
import { jsonResponse, problemResponse, unexpectedError } from '@/lib/http/problem';

/** Comfortably above the largest realistic Tive payload (~2 KB). */
const MAX_BODY_BYTES = 256 * 1024;

/** Ingestion is a handful of queries; fail fast rather than hold the sender. */
export const maxDuration = 15;

export async function POST(request: Request): Promise<Response> {
  // Honour an upstream correlation id when present so traces join up.
  const requestId = request.headers.get('x-request-id')?.trim() || randomUUID();
  const startedAt = Date.now();

  try {
    const config = getConfig();

    if (!isValidApiKey(extractApiKey(request.headers), config.API_KEYS)) {
      logger.warn('rejected unauthenticated request', {
        request_id: requestId,
        event: 'auth.rejected',
      });
      return problemResponse(IngestError.unauthorized(), requestId);
    }

    // Guard before parsing: an oversized body should not become an oversized
    // JSON document in memory.
    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_BODY_BYTES) {
      return problemResponse(IngestError.payloadTooLarge(MAX_BODY_BYTES), requestId);
    }

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return problemResponse(IngestError.payloadTooLarge(MAX_BODY_BYTES), requestId);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch (cause) {
      return problemResponse(IngestError.invalidJson(cause), requestId);
    }

    const outcome = await ingestTivePayload(body, requestId, {
      repo: createDrizzleRepository(getDb()),
      now: () => Date.now(),
      window: {
        maxAgeDays: config.TELEMETRY_MAX_AGE_DAYS,
        maxFutureSkewMinutes: config.TELEMETRY_MAX_FUTURE_SKEW_MINUTES,
      },
    });

    logger.info('request completed', {
      request_id: requestId,
      event: 'http.completed',
      status: outcome.status,
      duration_ms: Date.now() - startedAt,
    });

    // 201 when a reading was created; 200 when the idempotency key already
    // existed, so a retrying sender can tell the two apart.
    return jsonResponse(outcome, outcome.status === 'duplicate' ? 200 : 201, requestId);
  } catch (error) {
    if (error instanceof IngestError) {
      return problemResponse(error, requestId);
    }
    logger.error('unhandled error in webhook handler', {
      request_id: requestId,
      event: 'http.error',
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startedAt,
    });
    return unexpectedError(error, requestId);
  }
}
