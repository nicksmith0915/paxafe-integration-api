/**
 * End-to-end pipeline behaviour against an in-memory repository.
 *
 * These assert the things that only emerge from the *sequence* of steps --
 * ordering, status transitions, idempotency and the error paths -- which unit
 * tests on the transform cannot reach.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  PersistReadingsInput,
  PersistReadingsResult,
  RawPayloadInput,
  TelemetryRepository,
} from '@/lib/db/repository';
import type { IngestStatus } from '@/lib/db/schema';
import { IngestError } from '@/lib/ingest/errors';
import { ingestTivePayload } from '@/lib/ingest/pipeline';
import { FIXTURE_NOW, invalidPayload, validPayload } from './fixtures';

interface RawRecord {
  id: string;
  input: RawPayloadInput;
  status: IngestStatus | 'received';
  errorCode?: string;
}

class FakeRepository implements TelemetryRepository {
  raws: RawRecord[] = [];
  persisted: PersistReadingsInput[] = [];
  /** Idempotency key -> stored measurements, mirroring the unique index. */
  private stored = new Map<string, string>();
  persistShouldThrow: Error | null = null;
  insertShouldThrow: Error | null = null;
  finalizeShouldThrow: Error | null = null;

  async insertRawPayload(input: RawPayloadInput): Promise<string> {
    if (this.insertShouldThrow) throw this.insertShouldThrow;
    const id = `raw-${this.raws.length + 1}`;
    this.raws.push({ id, input, status: 'received' });
    return id;
  }

  async finalizeRawPayload(
    id: string,
    status: IngestStatus,
    error?: { code: string },
  ): Promise<void> {
    if (this.finalizeShouldThrow) throw this.finalizeShouldThrow;
    const row = this.raws.find((r) => r.id === id);
    if (!row) throw new Error(`finalize called for unknown raw payload ${id}`);
    row.status = status;
    row.errorCode = error?.code;
  }

  async persistReadings(input: PersistReadingsInput): Promise<PersistReadingsResult> {
    if (this.persistShouldThrow) throw this.persistShouldThrow;
    const key = `${input.sensor.device_imei}@${input.sensor.timestamp}`;
    const { sensor, location } = input;
    const measurements = JSON.stringify([
      sensor.temperature, sensor.humidity, sensor.light_level, sensor.accelerometer,
      location.latitude, location.longitude, location.battery_level, location.cellular_dbm,
    ]);
    this.persisted.push(input);

    const existing = this.stored.get(key);
    if (existing !== undefined) {
      return {
        outcome: existing === measurements ? 'duplicate' : 'conflict',
        sensorId: null,
        locationId: null,
      };
    }
    this.stored.set(key, measurements);
    return { outcome: 'created', sensorId: `s-${this.stored.size}`, locationId: `l-${this.stored.size}` };
  }
}

let repo: FakeRepository;
const deps = () => ({
  repo,
  now: () => FIXTURE_NOW,
  window: { maxAgeDays: 90, maxFutureSkewMinutes: 60 },
});

beforeEach(() => {
  repo = new FakeRepository();
});

describe('happy path', () => {
  it('persists the payload and reports the canonical identity back', async () => {
    const outcome = await ingestTivePayload(
      validPayload('Standard Temperature Shipment'),
      'req-1',
      deps(),
    );

    expect(outcome).toMatchObject({
      status: 'processed',
      request_id: 'req-1',
      device_id: 'A571992',
      device_imei: '863257063350583',
      timestamp: 1739215646000,
      sensor_id: 's-1',
      location_id: 'l-1',
    });
    expect(repo.raws[0].status).toBe('processed');
  });

  it('carries shipment context through to persistence', async () => {
    await ingestTivePayload(validPayload('Standard Temperature Shipment'), 'req-1', deps());
    const [persisted] = repo.persisted;
    expect(persisted.shipmentId).toBe('CL-13686/PHARMA-SHIP/COLD-LOGISTICS');
    expect(persisted.accountId).toBe(478);
    expect(persisted.shipmentContext?.carrier).toBe('EXCALIBUR');
  });

  it('handles a payload with no shipment block', async () => {
    const outcome = await ingestTivePayload(validPayload('Cellular Location Only'), 'req-1', deps());
    expect(outcome.status).toBe('processed');
    expect(repo.persisted[0].shipmentId).toBeNull();
    expect(repo.persisted[0].shipmentContext).toBeNull();
  });
});

describe('idempotency', () => {
  it('reports a replayed payload as duplicate rather than double-storing it', async () => {
    const payload = validPayload('GPS Location Shipment');
    const first = await ingestTivePayload(payload, 'req-1', deps());
    const second = await ingestTivePayload(payload, 'req-2', deps());

    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');
    expect(second.sensor_id).toBeNull();
    expect(repo.raws.map((r) => r.status)).toEqual(['processed', 'duplicate']);
  });
});

describe('rejections are recorded, not just returned', () => {
  it('stores the raw body before rejecting an invalid payload', async () => {
    await expect(
      ingestTivePayload(invalidPayload('Invalid Latitude'), 'req-1', deps()),
    ).rejects.toBeInstanceOf(IngestError);

    // The raw payload exists even though nothing was ever transformed.
    expect(repo.raws).toHaveLength(1);
    expect(repo.raws[0].status).toBe('rejected');
    expect(repo.raws[0].errorCode).toBe('SCHEMA_VALIDATION_FAILED');
    expect(repo.persisted).toHaveLength(0);
  });

  it('attributes a rejected payload to its device where possible', async () => {
    await expect(
      ingestTivePayload(invalidPayload('Invalid Longitude'), 'req-1', deps()),
    ).rejects.toBeInstanceOf(IngestError);
    expect(repo.raws[0].input.deviceImei).toBe('863257063350583');
  });

  it('rejects an out-of-window timestamp with a distinct code', async () => {
    const payload = { ...invalidPayload('Timestamp in Future'), DeviceId: '863257063350583' };
    await expect(ingestTivePayload(payload, 'req-1', deps())).rejects.toMatchObject({
      code: 'TIMESTAMP_OUT_OF_RANGE',
      status: 422,
      retryable: false,
    });
    expect(repo.raws[0].status).toBe('rejected');
  });

  it('surfaces every field problem in one response', async () => {
    try {
      await ingestTivePayload(invalidPayload('Missing Device Identifiers - Scenario A'), 'r', deps());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IngestError);
      expect((error as IngestError).issues.map((i) => i.path)).toContain('DeviceId');
      expect((error as IngestError).status).toBe(422);
    }
  });
});

describe('persistence failure', () => {
  it('reports an unavailable database as retryable, not as a generic 500', async () => {
    // The raw insert is the first thing to touch the database, so it is the
    // first thing to fail when the database is down.
    repo.insertShouldThrow = new Error('ECONNREFUSED 127.0.0.1:5432');

    await expect(
      ingestTivePayload(validPayload('Minimal Data Payload'), 'req-1', deps()),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED', status: 503, retryable: true });
  });

  it('still returns the real rejection when status bookkeeping fails', async () => {
    // A validation rejection must not be reported as a retryable 500 just
    // because the database went away while recording it.
    repo.finalizeShouldThrow = new Error('connection terminated');

    await expect(
      ingestTivePayload(invalidPayload('Invalid Latitude'), 'req-1', deps()),
    ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED', status: 422, retryable: false });
  });

  it('marks the payload failed and asks the sender to retry', async () => {
    repo.persistShouldThrow = new Error('connection terminated');

    await expect(
      ingestTivePayload(validPayload('Minimal Data Payload'), 'req-1', deps()),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED', status: 503, retryable: true });

    // Distinguished from 'rejected': the payload was fine, we were not.
    expect(repo.raws[0].status).toBe('failed');
  });
});

/**
 * Shaped like a real failure: Drizzle's "Failed query" wrapper, with the
 * postgres.js error carrying the SQLSTATE as its cause.
 */
function pgError(sqlstate: string, message: string): Error {
  return new Error('Failed query: insert into "sensor_readings" (...)\nparams: 863257063350583', {
    cause: Object.assign(new Error(message), { code: sqlstate }),
  });
}

describe('retryability follows the database error class', () => {
  it.each([
    ['22003', 'numeric field overflow'],
    ['22P05', 'unsupported Unicode escape sequence'],
    ['23502', 'null value in column violates not-null constraint'],
  ])('a data error (%s) during persistence is a permanent 422, not a retryable 503', async (sqlstate, message) => {
    repo.persistShouldThrow = pgError(sqlstate, message);

    await expect(
      ingestTivePayload(validPayload('Standard Temperature Shipment'), 'req-1', deps()),
    ).rejects.toMatchObject({ code: 'PAYLOAD_NOT_STORABLE', status: 422, retryable: false });

    // The payload was at fault, so it is 'rejected' -- not 'failed', which
    // would mark it as worth re-driving once the database recovers.
    expect(repo.raws[0].status).toBe('rejected');
  });

  it('a data error while recording the raw payload is also permanent', async () => {
    repo.insertShouldThrow = pgError('23502', 'null value in column "body"');

    await expect(
      ingestTivePayload(validPayload('Minimal Data Payload'), 'req-1', deps()),
    ).rejects.toMatchObject({ code: 'PAYLOAD_NOT_STORABLE', status: 422, retryable: false });
  });

  it.each([
    ['08006', 'connection failure'],
    ['40P01', 'deadlock detected'],
    ['57P01', 'terminating connection due to administrator command'],
  ])('an availability error (%s) stays a retryable 503', async (sqlstate, message) => {
    repo.persistShouldThrow = pgError(sqlstate, message);

    await expect(
      ingestTivePayload(validPayload('Standard Temperature Shipment'), 'req-1', deps()),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED', status: 503, retryable: true });
    expect(repo.raws[0].status).toBe('failed');
  });
});

describe('payload shape', () => {
  it.each([
    ['null', null, 'received null'],
    ['a string', 'hello', 'received string'],
    ['a number', 42, 'received number'],
  ])('rejects a body that is %s, and still records it', async (_label, body, expected) => {
    await expect(ingestTivePayload(body, 'req-1', deps())).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
      status: 422,
      issues: [expect.objectContaining({ path: '(root)', message: expect.stringContaining(expected) })],
    });
    expect(repo.raws).toHaveLength(1);
    expect(repo.raws[0].input.body).toEqual(body);
    expect(repo.raws[0].status).toBe('rejected');
  });

  it('explains that batches are unsupported when sent an array', async () => {
    const batch = [validPayload('Standard Temperature Shipment')];
    await expect(ingestTivePayload(batch, 'req-1', deps())).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringContaining('Batches are not supported') })],
    });
  });
});

describe('NUL bytes', () => {
  const NUL = String.fromCharCode(0);
  const REPLACEMENT = String.fromCharCode(0xfffd);

  it('replaces them before recording, so the audit row can be written', async () => {
    const payload = { ...validPayload('Standard Temperature Shipment'), DeviceName: `A571${NUL}992` };

    const outcome = await ingestTivePayload(payload, 'req-1', deps());

    expect(outcome.status).toBe('processed');
    expect(outcome.data_quality_flags).toContain('nul_bytes_replaced');
    const stored = repo.raws[0].input.body as { DeviceName: string };
    expect(stored.DeviceName).toBe(`A571${REPLACEMENT}992`);
    expect(stored.DeviceName.includes(NUL)).toBe(false);
    expect(outcome.device_id).toBe(`A571${REPLACEMENT}992`);
  });
});

describe('conflicting duplicates', () => {
  it('rejects a different reading for an existing key instead of calling it a duplicate', async () => {
    const original = validPayload('GPS Location Shipment');
    const contradiction = { ...original, Temperature: { Celsius: 30, Fahrenheit: 86 } };

    await ingestTivePayload(original, 'req-1', deps());
    await expect(ingestTivePayload(contradiction, 'req-2', deps())).rejects.toMatchObject({
      code: 'CONFLICTING_DUPLICATE',
      status: 409,
      retryable: false,
    });

    // Retained for a human to review, and distinguishable from a plain reject.
    expect(repo.raws.map((r) => r.status)).toEqual(['processed', 'conflict']);
  });

  it('still treats an identical replay as a harmless duplicate', async () => {
    const payload = validPayload('GPS Location Shipment');
    await ingestTivePayload(payload, 'req-1', deps());
    await expect(ingestTivePayload(payload, 'req-2', deps())).resolves.toMatchObject({ status: 'duplicate' });
  });
});

describe('implausible sensor values', () => {
  it('stores a glitching humidity sensor as null without losing the rest of the reading', async () => {
    const payload = { ...validPayload('Standard Temperature Shipment'), Humidity: { Percentage: 1000 } };

    const outcome = await ingestTivePayload(payload, 'req-1', deps());

    expect(outcome.status).toBe('processed');
    expect(outcome.data_quality_flags).toContain('humidity_out_of_range');
    expect(repo.persisted[0].sensor.humidity).toBeNull();
    expect(repo.persisted[0].sensor.temperature).toBe(10.08);
  });
});

describe('inputs that used to crash the handler', () => {
  it('rejects pathologically nested JSON with a 422 instead of overflowing the stack', async () => {
    const depth = 100_000;
    const body = JSON.parse('['.repeat(depth) + ']'.repeat(depth));

    await expect(ingestTivePayload(body, 'req-1', deps())).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
      status: 422,
      retryable: false,
      issues: [expect.objectContaining({ message: expect.stringContaining('nested more than 32 levels') })],
    });

    // Still audited: a stub stands in for the body that could not be serialised.
    expect(repo.raws[0].input.body).toEqual({ unstorable_body: 'nesting_depth_exceeded', max_depth: 32 });
    expect(repo.raws[0].status).toBe('rejected');
  });

  it('rejects a timestamp beyond the representable date range with a 422', async () => {
    const payload = { ...validPayload('Standard Temperature Shipment'), EntryTimeEpoch: 8_700_000_000_000_000 };
    await expect(ingestTivePayload(payload, 'req-1', deps())).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
      status: 422,
      issues: [expect.objectContaining({ path: 'EntryTimeEpoch' })],
    });
  });
});
