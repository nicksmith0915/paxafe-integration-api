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

export async function ingestTivePayload(
  body: unknown,
  requestId: string,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  const rawPayloadId = await deps.repo.insertRawPayload({
    requestId,
    provider: PROVIDER,
    body,
    deviceImei: peekDeviceImei(body),
    recordedAt: peekEpoch(body),
  });

  // --- Validate -------------------------------------------------------------

  const parsed = TivePayloadSchema.safeParse(body);
  if (!parsed.success) {
    const issues = toFieldIssues(parsed.error);
    await deps.repo.finalizeRawPayload(rawPayloadId, 'rejected', {
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
    await deps.repo.finalizeRawPayload(rawPayloadId, 'rejected', {
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
    await deps.repo.finalizeRawPayload(rawPayloadId, 'failed', {
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
  await deps.repo.finalizeRawPayload(rawPayloadId, status);

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
