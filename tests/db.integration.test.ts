/**
 * Persistence integration tests.
 *
 * Skipped unless TEST_DATABASE_URL points at a disposable Postgres. They cover
 * the properties the in-memory fake cannot: that the unique index really does
 * enforce idempotency, that the transaction is atomic, and that numeric columns
 * round-trip without float drift.
 *
 *   TEST_DATABASE_URL=postgres://... npm run db:migrate
 *   TEST_DATABASE_URL=postgres://... npm test
 *
 * Run against a throwaway database -- each test truncates the tables it uses.
 *
 * Timeouts are generous because this may run against a managed database several
 * hundred milliseconds away, where a handful of round-trips comfortably exceeds
 * Vitest's 5s default. Against the localhost Postgres that CI provides, these
 * finish in well under a second.
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
const TIMEOUT = 30_000;

describe.skipIf(!TEST_DATABASE_URL)('persistence against a live database', () => {
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(TEST_DATABASE_URL ?? '');
  const client = postgres(TEST_DATABASE_URL!, {
    max: 1,
    prepare: false,
    ssl: isLocal ? false : 'require',
  });
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
  }, TIMEOUT);

  afterAll(async () => {
    await client.end({ timeout: 5 });
  }, TIMEOUT);

  it(
    'stores a sensor and location record for one payload',
    async () => {
      const result = await store('Standard Temperature Shipment');
      expect(result.duplicate).toBe(false);
      expect(result.sensorId).toBeTruthy();
      expect(result.locationId).toBeTruthy();
    },
    TIMEOUT,
  );

  it(
    'round-trips numeric precision without float drift',
    async () => {
      await store('Standard Temperature Shipment');
      const [row] = await db
        .select({
          temperature: schema.sensorReadings.temperature,
          humidity: schema.sensorReadings.humidity,
          x: schema.sensorReadings.accelX,
        })
        .from(schema.sensorReadings);
      expect(row.temperature).toBe(10.08);
      expect(row.humidity).toBe(38.7);
      expect(row.x).toBe(-0.563);
    },
    TIMEOUT,
  );

  it(
    'is idempotent: a replayed payload does not create a second reading',
    async () => {
      await store('GPS Location Shipment');
      const second = await store('GPS Location Shipment');

      expect(second.duplicate).toBe(true);
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.sensorReadings);
      expect(count).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'writes both canonical records with a shared correlation key',
    async () => {
      await store('Standard Temperature Shipment');
      const [sensorRow] = await db.select().from(schema.sensorReadings);
      const [locationRow] = await db.select().from(schema.locationReadings);

      expect(sensorRow.deviceImei).toBe(locationRow.deviceImei);
      expect(sensorRow.recordedAt.getTime()).toBe(locationRow.recordedAt.getTime());
      expect(locationRow.locationAccuracyCategory).toBe('High');
      expect(locationRow.locationSource).toBe('WiFi');
    },
    TIMEOUT,
  );

  it(
    'upserts the device without dragging last_seen_at backwards',
    async () => {
      await store('Standard Temperature Shipment');
      const [device] = await db.select().from(schema.devices);
      expect(device.deviceImei).toBe('863257063350583');
      expect(device.deviceId).toBe('A571992');

      // Re-storing the same (older) reading must not move last_seen_at back.
      const before = device.lastSeenAt.getTime();
      await store('Standard Temperature Shipment');
      const [again] = await db.select().from(schema.devices);
      expect(again.lastSeenAt.getTime()).toBe(before);
    },
    TIMEOUT,
  );

  it(
    'records the raw payload alongside the readings',
    async () => {
      await store('Standard Temperature Shipment');
      const [raw] = await db.select().from(schema.rawPayloads);
      expect(raw.provider).toBe('Tive');
      expect(raw.deviceImei).toBe('863257063350583');
      expect(raw.body).toMatchObject({ DeviceName: 'A571992' });
    },
    TIMEOUT,
  );
});
