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
  /** Idempotency key -> already stored, mirroring the unique index. */
  private seen = new Set<string>();
  persistShouldThrow: Error | null = null;

  async insertRawPayload(input: RawPayloadInput): Promise<string> {
    const id = `raw-${this.raws.length + 1}`;
    this.raws.push({ id, input, status: 'received' });
    return id;
  }

  async finalizeRawPayload(
    id: string,
    status: IngestStatus,
    error?: { code: string },
  ): Promise<void> {
    const row = this.raws.find((r) => r.id === id);
    if (!row) throw new Error(`finalize called for unknown raw payload ${id}`);
    row.status = status;
    row.errorCode = error?.code;
  }

  async persistReadings(input: PersistReadingsInput): Promise<PersistReadingsResult> {
    if (this.persistShouldThrow) throw this.persistShouldThrow;
    const key = `${input.sensor.device_imei}@${input.sensor.timestamp}`;
    this.persisted.push(input);
    if (this.seen.has(key)) {
      return { sensorId: null, locationId: null, duplicate: true };
    }
    this.seen.add(key);
    return { sensorId: `s-${this.seen.size}`, locationId: `l-${this.seen.size}`, duplicate: false };
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
  it('marks the payload failed and asks the sender to retry', async () => {
    repo.persistShouldThrow = new Error('connection terminated');

    await expect(
      ingestTivePayload(validPayload('Minimal Data Payload'), 'req-1', deps()),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED', status: 503, retryable: true });

    // Distinguished from 'rejected': the payload was fine, we were not.
    expect(repo.raws[0].status).toBe('failed');
  });
});
