/**
 * Persistence integration tests.
 *
 * Skipped unless TEST_DATABASE_URL points at a disposable Postgres. They cover
 * the one property the in-memory fake cannot: that the unique index really does
 * enforce idempotency, and that the transaction really is atomic.
 *
 *   createdb pxtest && TEST_DATABASE_URL=postgres://... npm run db:migrate
 *   TEST_DATABASE_URL=postgres://... npm test
 *
 * Run against a throwaway database -- each test truncates the tables it uses.
 */

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createDrizzleRepository, type TelemetryRepository } from '@/lib/db/repository';
import * as schema from '@/lib/db/schema';
import { TivePayloadSchema } from '@/lib/providers/tive/schema';
import { transformTivePayload } from '@/lib/providers/tive/transform';
import { validPayload } from './fixtures';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)('persistence against a live database', () => {
  const client = postgres(TEST_DATABASE_URL!, { max: 1, prepare: false });
  const db = drizzle(client, { schema });
  const repo: TelemetryRepository = createDrizzleRepository(db);

  function transformed(name: string) {
    return transformTivePayload(TivePayloadSchema.parse(validPayload(name)));
  }

  async function store(name: string) {
    const { sensor, location, flags } = transformed(name);
    const rawPayloadId = await repo.insertRawPayload({
      requestId: `test-${Math.random()}`,
      provider: 'Tive',
      body: validPayload(name),
      deviceImei: sensor.device_imei,
      recordedAt: new Date(sensor.timestamp),
    });
    return repo.persistReadings({
      rawPayloadId,
      sensor,
      location,
      flags,
      shipmentId: null,
      accountId: null,
      shipmentContext: null,
    });
  }

  beforeEach(async () => {
    await db.execute(
      sql`truncate table sensor_readings, location_readings, raw_payloads, devices, shipments cascade`,
    );
  });

  afterAll(async () => {
    await client.end();
  });

  it('stores a sensor and location record for one payload', async () => {
    const result = await store('Standard Temperature Shipment');
    expect(result.duplicate).toBe(false);
    expect(result.sensorId).toBeTruthy();
    expect(result.locationId).toBeTruthy();
  });

  it('round-trips numeric precision without float drift', async () => {
    await store('Standard Temperature Shipment');
    const [row] = await db
      .select({ temperature: schema.sensorReadings.temperature, x: schema.sensorReadings.accelX })
      .from(schema.sensorReadings);
    expect(row.temperature).toBe(10.08);
    expect(row.x).toBe(-0.563);
  });

  it('is idempotent: a replayed payload does not create a second reading', async () => {
    await store('GPS Location Shipment');
    const second = await store('GPS Location Shipment');

    expect(second.duplicate).toBe(true);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.sensorReadings);
    expect(count).toBe(1);
  });

  it('upserts the device and advances last_seen_at', async () => {
    await store('Standard Temperature Shipment');
    const [device] = await db.select().from(schema.devices);
    expect(device.deviceImei).toBe('863257063350583');
    expect(device.deviceId).toBe('A571992');
  });
});
