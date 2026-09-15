/**
 * Ingestion pipeline.
 *
 *   sanitise -> store raw -> validate -> check window -> transform -> persist -> finalize
 *
 * Three properties drive the ordering:
 *
 *  1. The raw body is persisted *first*, before anything can reject it. A
 *     validation bug, a transform bug or a schema drift on Tive's side then
 *     leaves a replayable row rather than a lost reading. This is also the seam
 *     where a queue would be introduced: everything after step 1 could move to
 *     a worker without changing the contract the sender sees.
 *  2. Rejections are recorded, not just returned. `raw_payloads.status` plus
 *     `error_code` makes "what is this sender getting wrong?" a SQL query.
 *  3. Retryability is derived, never assumed. A database failure is reported as
 *     retryable only when the database itself was the problem; when it rejected
 *     the data, a retry would fail identically forever.
 *
 * Dependencies are injected so the whole pipeline can be exercised against a
 * stub database and a fixed clock.
 */

import type { z } from 'zod';

import { classifyDbError } from '@/lib/db/errors';
import type { PersistReadingsResult, TelemetryRepository } from '@/lib/db/repository';
import type { IngestStatus } from '@/lib/db/schema';
import { logger } from '@/lib/http/logger';
import { TivePayloadSchema, type TivePayload } from '@/lib/providers/tive/schema';
import { transformTivePayload } from '@/lib/providers/tive/transform';
import type { DataQualityFlag } from '@/lib/px/types';
import { IngestError, type FieldIssue } from './errors';
import { exceedsNestingDepth, MAX_NESTING_DEPTH, payloadShapeIssue, replaceNulBytes } from './sanitize';
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
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).DeviceId;
  return typeof value === 'string' ? value : null;
}

function peekEpoch(body: unknown): Date | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).EntryTimeEpoch;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  // An absurd epoch must not become the reason the audit row cannot be written.
  return Number.isNaN(date.getTime()) ? null : date;
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
  status: IngestStatus,
  error?: { code: string; detail?: unknown },
): Promise<void> {
  try {
    await deps.repo.finalizeRawPayload(rawPayloadId, status, error);
  } catch (cause) {
    logger.error('failed to finalise raw payload status', {
      request_id: requestId,
      event: 'ingest.finalize_failed',
      status,
      error: classifyDbError(cause).message,
    });
  }
}

/**
 * Translates a database failure into the error the sender should see. When the
 * database rejected the data itself, retrying is pointless: 422. When it was
 * unavailable, the payload is fine and a retry is exactly right: 503.
 */
function persistenceError(cause: unknown, whenUnavailable: string): IngestError {
  const info = classifyDbError(cause);
  if (!info.retryable) return IngestError.notStorable(cause);
  return new IngestError('PERSISTENCE_FAILED', 503, whenUnavailable, { cause, retryable: true });
}

export async function ingestTivePayload(
  body: unknown,
  requestId: string,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  // --- Sanitise and record ----------------------------------------------------

  /**
   * A body nested too deeply cannot be walked, validated or even serialised for
   * storage without overflowing the stack. Record a stub in its place so the
   * request still leaves an audit row, then reject it.
   */
  const tooDeep = exceedsNestingDepth(body);
  const { value: storableBody, replaced: nulBytesReplaced } = tooDeep
    ? { value: { unstorable_body: 'nesting_depth_exceeded', max_depth: MAX_NESTING_DEPTH }, replaced: false }
    : replaceNulBytes(body);

  let rawPayloadId: string;
  try {
    rawPayloadId = await deps.repo.insertRawPayload({
      requestId,
      provider: PROVIDER,
      body: storableBody,
      deviceImei: peekDeviceImei(storableBody),
      recordedAt: peekEpoch(storableBody),
    });
  } catch (cause) {
    const info = classifyDbError(cause);
    logger.error('failed to record raw payload', {
      request_id: requestId,
      event: 'ingest.failed',
      error_code: info.retryable ? 'PERSISTENCE_FAILED' : 'PAYLOAD_NOT_STORABLE',
      sqlstate: info.sqlstate,
      device_imei: peekDeviceImei(storableBody),
      error: info.message,
    });
    throw persistenceError(cause, 'Could not record the payload. Retry later.');
  }

  const reject = async (error: IngestError, detail: unknown): Promise<never> => {
    await safeFinalize(deps, requestId, rawPayloadId, 'rejected', { code: error.code, detail });
    logger.warn('payload rejected', {
      request_id: requestId,
      event: 'ingest.rejected',
      error_code: error.code,
      device_imei: peekDeviceImei(storableBody),
      issue_count: error.issues.length,
    });
    throw error;
  };

  // --- Validate -------------------------------------------------------------

  if (tooDeep) {
    const issue: FieldIssue = {
      path: '(root)',
      message: `Payload is nested more than ${MAX_NESTING_DEPTH} levels deep. A telemetry payload is a flat object of at most a few levels.`,
    };
    await reject(IngestError.schemaValidation([issue]), [issue]);
  }

  const shapeIssue = payloadShapeIssue(storableBody);
  if (shapeIssue) await reject(IngestError.schemaValidation([shapeIssue]), [shapeIssue]);

  const parsed = TivePayloadSchema.safeParse(storableBody);
  if (!parsed.success) {
    const issues = toFieldIssues(parsed.error);
    await reject(IngestError.schemaValidation(issues), issues);
  }
  const payload: TivePayload = parsed.data!;

  // --- Ingestion window (policy, not schema) --------------------------------

  const windowIssues = checkTimestampWindow(payload.EntryTimeEpoch, deps.now(), deps.window);
  if (windowIssues.length > 0) await reject(IngestError.timestampOutOfRange(windowIssues), windowIssues);

  if (!utcMatchesEpoch(payload.EntryTimeUtc, payload.EntryTimeEpoch)) {
    // Not fatal: EntryTimeEpoch is authoritative. Worth knowing if it recurs.
    logger.warn('EntryTimeUtc disagrees with EntryTimeEpoch', {
      request_id: requestId,
      event: 'ingest.timestamp_mismatch',
      device_imei: payload.DeviceId,
    });
  }

  // --- Transform and persist ------------------------------------------------

  const transformed = transformTivePayload(payload);
  const { sensor, location } = transformed;
  const flags: DataQualityFlag[] = nulBytesReplaced
    ? ['nul_bytes_replaced', ...transformed.flags]
    : transformed.flags;

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
    const info = classifyDbError(cause);
    const error = persistenceError(cause, 'Could not persist the reading. Retry later.');
    // 'rejected' when the data was at fault, 'failed' when we were -- only the
    // latter is worth re-driving once the database recovers.
    await safeFinalize(deps, requestId, rawPayloadId, info.retryable ? 'failed' : 'rejected', {
      code: error.code,
      detail: { sqlstate: info.sqlstate, message: info.message },
    });
    logger.error('failed to persist readings', {
      request_id: requestId,
      event: 'ingest.failed',
      error_code: error.code,
      sqlstate: info.sqlstate,
      device_imei: sensor.device_imei,
      error: info.message,
    });
    throw error;
  }

  if (result.outcome === 'conflict') {
    const issues: FieldIssue[] = [
      {
        path: 'EntryTimeEpoch',
        message:
          `Device ${sensor.device_imei} already has a reading at ${new Date(sensor.timestamp).toISOString()} ` +
          'with different measurements. The stored reading was kept; this payload is retained for review.',
      },
    ];
    await safeFinalize(deps, requestId, rawPayloadId, 'conflict', {
      code: 'CONFLICTING_DUPLICATE',
      detail: issues,
    });
    logger.warn('conflicting reading for an existing idempotency key', {
      request_id: requestId,
      event: 'ingest.conflict',
      error_code: 'CONFLICTING_DUPLICATE',
      device_imei: sensor.device_imei,
    });
    throw IngestError.conflictingDuplicate(issues);
  }

  const status = result.outcome === 'duplicate' ? 'duplicate' : 'processed';
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
