/**
 * Ingestion pipeline.
 *
 *   store raw -> validate -> check window -> transform -> persist -> finalize
 *
 * Two properties drive the ordering:
 *
 *  1. The raw body is persisted *first*, before anything can reject it. A
 *     validation bug, a transform bug or a schema drift on Tive's side then
 *     leaves a replayable row rather than a lost reading. This is also the seam
 *     where a queue would be introduced: everything after step 1 could move to
 *     a worker without changing the contract the sender sees.
 *  2. Rejections are recorded, not just returned. `raw_payloads.status` plus
 *     `error_code` makes "what is this sender getting wrong?" a SQL query.
 *
 * Dependencies are injected so the whole pipeline can be exercised against a
 * stub database and a fixed clock.
 */

import type { z } from 'zod';

import type {
  PersistReadingsResult,
  TelemetryRepository,
} from '@/lib/db/repository';
import { logger } from '@/lib/http/logger';
import { TivePayloadSchema, type TivePayload } from '@/lib/providers/tive/schema';
import { transformTivePayload } from '@/lib/providers/tive/transform';
import type { DataQualityFlag } from '@/lib/px/types';
import { IngestError, type FieldIssue } from './errors';
import { checkTimestampWindow, utcMatchesEpoch, type IngestionWindow } from './timestamp';

const PROVIDER = 'Tive';

export interface IngestDeps {
  repo: TelemetryRepository;
  now: () => number;
  window: IngestionWindow;
}

export interface IngestOutcome {
  status: 'processed' | 'duplicate';
  request_id: string;
  device_id: string;
  device_imei: string;
  timestamp: number;
  sensor_id: string | null;
  location_id: string | null;
  data_quality_flags: DataQualityFlag[];
}

/** Zod paths are arrays; senders need a dotted path into their own payload. */
function toFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Read the IMEI out of an unvalidated body so that even a rejected payload can
 * be attributed to a device. Never throws: this is a convenience, not a check.
 */
function peekDeviceImei(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>).DeviceId;
  return typeof value === 'string' ? value : null;
}

function peekEpoch(body: unknown): Date | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>).EntryTimeEpoch;
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value) : null;
}

/**
 * Status finalisation is bookkeeping, not the result. If it fails -- typically
 * because the database went away mid-request -- the sender must still receive
 * the real outcome. A validation rejection reported as a 500 would tell a sender
 * to retry a payload that can never succeed. The row is left as 'received',
 * which is recoverable, and the failure is logged.
 */
async function safeFinalize(
  deps: IngestDeps,
  requestId: string,
  rawPayloadId: string,
  status: 'processed' | 'duplicate' | 'rejected' | 'failed',
  error?: { code: string; detail?: unknown },
): Promise<void> {
  try {
    await deps.repo.finalizeRawPayload(rawPayloadId, status, error);
  } catch (cause) {
    logger.error('failed to finalise raw payload status', {
      request_id: requestId,
      event: 'ingest.finalize_failed',
      status,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export async function ingestTivePayload(
  body: unknown,
  requestId: string,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  /**
   * The database is unavailable far more often than any other dependency, and
   * this is the first thing that touches it. Without this guard the failure
   * surfaces as a generic 500, telling the sender nothing about whether a retry
   * could help -- when in fact it is the one failure that is always retryable.
   */
  let rawPayloadId: string;
  try {
    rawPayloadId = await deps.repo.insertRawPayload({
      requestId,
      provider: PROVIDER,
      body,
      deviceImei: peekDeviceImei(body),
      recordedAt: peekEpoch(body),
    });
  } catch (cause) {
    logger.error('failed to record raw payload', {
      request_id: requestId,
      event: 'ingest.failed',
      error_code: 'PERSISTENCE_FAILED',
      device_imei: peekDeviceImei(body),
      error: cause instanceof Error ? cause.message : String(cause),
    });
    throw new IngestError(
      'PERSISTENCE_FAILED',
      503,
      'Could not record the payload. Retry later.',
      { cause, retryable: true },
    );
  }

  // --- Validate -------------------------------------------------------------

  const parsed = TivePayloadSchema.safeParse(body);
  if (!parsed.success) {
    const issues = toFieldIssues(parsed.error);
    await safeFinalize(deps, requestId, rawPayloadId, 'rejected', {
      code: 'SCHEMA_VALIDATION_FAILED',
      detail: issues,
    });
    logger.warn('payload rejected by schema validation', {
      request_id: requestId,
      event: 'ingest.rejected',
      error_code: 'SCHEMA_VALIDATION_FAILED',
      device_imei: peekDeviceImei(body),
      issue_count: issues.length,
    });
    throw IngestError.schemaValidation(issues);
  }

  const payload: TivePayload = parsed.data;

  // --- Ingestion window (policy, not schema) --------------------------------

  const windowIssues = checkTimestampWindow(payload.EntryTimeEpoch, deps.now(), deps.window);
  if (windowIssues.length > 0) {
    await safeFinalize(deps, requestId, rawPayloadId, 'rejected', {
      code: 'TIMESTAMP_OUT_OF_RANGE',
      detail: windowIssues,
    });
    logger.warn('payload outside ingestion window', {
      request_id: requestId,
      event: 'ingest.rejected',
      error_code: 'TIMESTAMP_OUT_OF_RANGE',
      device_imei: payload.DeviceId,
    });
    throw IngestError.timestampOutOfRange(windowIssues);
  }

  if (!utcMatchesEpoch(payload.EntryTimeUtc, payload.EntryTimeEpoch)) {
    // Not fatal: EntryTimeEpoch is authoritative. Worth knowing if it recurs.
    logger.warn('EntryTimeUtc disagrees with EntryTimeEpoch', {
      request_id: requestId,
      event: 'ingest.timestamp_mismatch',
      device_imei: payload.DeviceId,
    });
  }

  // --- Transform and persist ------------------------------------------------

  const { sensor, location, flags } = transformTivePayload(payload);

  let result: PersistReadingsResult;
  try {
    result = await deps.repo.persistReadings({
      rawPayloadId,
      sensor,
      location,
      flags,
      shipmentId: payload.ShipmentId ?? payload.Shipment?.Id ?? null,
      accountId: payload.AccountId ?? null,
      shipmentContext: payload.Shipment
        ? {
            publicShipmentId: payload.PublicShipmentId ?? null,
            description: payload.Shipment.Description ?? null,
            carrier: payload.Shipment.Carrier ?? null,
            shipFrom: payload.Shipment.ShipFrom ?? null,
            shipTo: payload.Shipment.ShipTo ?? null,
          }
        : null,
    });
  } catch (cause) {
    await safeFinalize(deps, requestId, rawPayloadId, 'failed', {
      code: 'PERSISTENCE_FAILED',
      detail: { message: cause instanceof Error ? cause.message : String(cause) },
    });
    logger.error('failed to persist readings', {
      request_id: requestId,
      event: 'ingest.failed',
      error_code: 'PERSISTENCE_FAILED',
      device_imei: sensor.device_imei,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    // Retryable: the payload was valid, the database was not available.
    throw new IngestError('PERSISTENCE_FAILED', 503, 'Could not persist the reading. Retry later.', {
      cause,
      retryable: true,
    });
  }

  const status = result.duplicate ? 'duplicate' : 'processed';
  await safeFinalize(deps, requestId, rawPayloadId, status);

  logger.info('payload ingested', {
    request_id: requestId,
    event: 'ingest.accepted',
    status,
    device_imei: sensor.device_imei,
    flags: flags.length > 0 ? flags : undefined,
  });

  return {
    status,
    request_id: requestId,
    device_id: sensor.device_id,
    device_imei: sensor.device_imei,
    timestamp: sensor.timestamp,
    sensor_id: result.sensorId,
    location_id: result.locationId,
    data_quality_flags: flags,
  };
}
