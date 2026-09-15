/**
 * Persistence layer.
 *
 * The only module that knows SQL. Everything above it deals in canonical PX
 * types, so swapping the storage engine or adding a provider touches nothing
 * here beyond the shipment/device context helpers.
 */

import { and, eq, sql } from 'drizzle-orm';

import type { DataQualityFlag, PxLocationPayload, PxSensorPayload } from '@/lib/px/types';
import type { DrizzleDb } from './client';
import {
  devices,
  locationReadings,
  rawPayloads,
  sensorReadings,
  shipments,
  type IngestStatus,
} from './schema';

export interface RawPayloadInput {
  requestId: string;
  provider: string;
  body: unknown;
  deviceImei?: string | null;
  recordedAt?: Date | null;
}

/**
 * Written before validation, and deliberately outside the readings transaction:
 * if anything downstream fails, this row must still survive as the replayable
 * record of what the provider actually sent.
 */
export async function insertRawPayload(db: DrizzleDb, input: RawPayloadInput): Promise<string> {
  const [row] = await db
    .insert(rawPayloads)
    .values({
      requestId: input.requestId,
      provider: input.provider,
      /**
       * A JSON `null` body is valid JSON and still worth recording, but Drizzle
       * binds a JS null as SQL NULL, which the NOT NULL column rejects. Writing
       * the JSON literal keeps the audit row -- and its rejection -- on record.
       */
      body: input.body === null ? sql`'null'::jsonb` : (input.body as object),
      status: 'received',
      deviceImei: input.deviceImei ?? null,
      recordedAt: input.recordedAt ?? null,
    })
    .returning({ id: rawPayloads.id });
  return row.id;
}

export async function finalizeRawPayload(
  db: DrizzleDb,
  id: string,
  status: IngestStatus,
  error?: { code: string; detail?: unknown },
): Promise<void> {
  await db
    .update(rawPayloads)
    .set({
      status,
      errorCode: error?.code ?? null,
      errorDetail: (error?.detail as object) ?? null,
    })
    .where(sql`${rawPayloads.id} = ${id}`);
}

export interface PersistReadingsInput {
  rawPayloadId: string;
  sensor: PxSensorPayload;
  location: PxLocationPayload;
  flags: DataQualityFlag[];
  shipmentId: string | null;
  accountId: number | null;
  shipmentContext: {
    publicShipmentId: string | null;
    description: string | null;
    carrier: string | null;
    shipFrom: unknown;
    shipTo: unknown;
  } | null;
}

/**
 * What happened to a reading whose idempotency key is (device_imei, recorded_at):
 *
 *   created    first time this key was seen
 *   duplicate  key existed with identical measurements -- a retried webhook
 *   conflict   key existed with *different* measurements; nothing was written
 */
export type PersistOutcome = 'created' | 'duplicate' | 'conflict';

export interface PersistReadingsResult {
  outcome: PersistOutcome;
  sensorId: string | null;
  locationId: string | null;
}

/** Thrown inside the transaction to roll back a conflicting write. */
class ConflictingReading extends Error {}

/**
 * The measured values of a reading, in a fixed order. Deliberately excludes the
 * device name (renameable mid-shipment) and address (geocoder output that can
 * vary for identical coordinates): a conflict means the *measurements* differ.
 * Values from the database come back through `numeric` columns in number mode,
 * so both sides compare as already-rounded numbers.
 */
function measurementFingerprint(values: {
  temperature: number | null;
  humidity: number | null;
  lightLevel: number | null;
  accelX: number | null;
  accelY: number | null;
  accelZ: number | null;
  accelMagnitude: number | null;
  latitude: number | null;
  longitude: number | null;
  locationAccuracy: number | null;
  batteryLevel: number | null;
  cellularDbm: number | null;
  wifiAccessPoints: number | null;
}): string {
  return JSON.stringify([
    values.temperature,
    values.humidity,
    values.lightLevel,
    values.accelX,
    values.accelY,
    values.accelZ,
    values.accelMagnitude,
    values.latitude,
    values.longitude,
    values.locationAccuracy,
    values.batteryLevel,
    values.cellularDbm,
    values.wifiAccessPoints,
  ]);
}

/**
 * Writes both canonical records plus device/shipment context atomically. Either
 * a payload is fully represented or not at all -- a sensor reading without its
 * matching location would silently corrupt the joined view.
 */
export async function persistReadings(
  db: DrizzleDb,
  input: PersistReadingsInput,
): Promise<PersistReadingsResult> {
  const recordedAt = new Date(input.sensor.timestamp);

  try {
    return await writeReadings(db, input, recordedAt);
  } catch (error) {
    if (error instanceof ConflictingReading) {
      return { outcome: 'conflict', sensorId: null, locationId: null };
    }
    throw error;
  }
}

async function writeReadings(
  db: DrizzleDb,
  input: PersistReadingsInput,
  recordedAt: Date,
): Promise<PersistReadingsResult> {
  const { sensor, location, flags } = input;

  return db.transaction(async (tx) => {
    await tx
      .insert(devices)
      .values({
        deviceImei: sensor.device_imei,
        deviceId: sensor.device_id,
        provider: sensor.provider,
        deviceType: sensor.type,
        accountId: input.accountId,
        lastSeenAt: recordedAt,
      })
      .onConflictDoUpdate({
        target: devices.deviceImei,
        set: {
          // DeviceName is user-programmable and can be renamed mid-shipment;
          // keep the newest value while preserving first_seen_at.
          deviceId: sensor.device_id,
          /**
           * `excluded` is the row this statement tried to insert. Referencing it
           * keeps the timestamp as the value Drizzle already bound for the
           * insert; interpolating the JS Date into this raw fragment instead
           * bypasses the column type mapping and fails at bind time.
           *
           * greatest() guards against out-of-order delivery: a buffered reading
           * arriving late must not drag last_seen_at backwards.
           */
          lastSeenAt: sql`greatest(${devices.lastSeenAt}, excluded.last_seen_at)`,
        },
      });

    if (input.shipmentId && input.shipmentContext) {
      await tx
        .insert(shipments)
        .values({
          shipmentId: input.shipmentId,
          publicShipmentId: input.shipmentContext.publicShipmentId,
          description: input.shipmentContext.description,
          carrier: input.shipmentContext.carrier,
          shipFrom: input.shipmentContext.shipFrom as object,
          shipTo: input.shipmentContext.shipTo as object,
          accountId: input.accountId,
        })
        .onConflictDoUpdate({
          target: shipments.shipmentId,
          set: {
            description: input.shipmentContext.description,
            carrier: input.shipmentContext.carrier,
            updatedAt: new Date(),
          },
        });
    }

    const [sensorRow] = await tx
      .insert(sensorReadings)
      .values({
        rawPayloadId: input.rawPayloadId,
        deviceImei: sensor.device_imei,
        deviceId: sensor.device_id,
        recordedAt,
        provider: sensor.provider,
        deviceType: sensor.type,
        temperature: sensor.temperature,
        humidity: sensor.humidity,
        lightLevel: sensor.light_level,
        accelX: sensor.accelerometer?.x ?? null,
        accelY: sensor.accelerometer?.y ?? null,
        accelZ: sensor.accelerometer?.z ?? null,
        accelMagnitude: sensor.accelerometer?.magnitude ?? null,
        tilt: sensor.tilt as object | null,
        boxOpen: sensor.box_open,
        shipmentId: input.shipmentId,
        dataQualityFlags: flags,
      })
      // Idempotent by design: a retried webhook must not duplicate the reading.
      .onConflictDoNothing({ target: [sensorReadings.deviceImei, sensorReadings.recordedAt] })
      .returning({ id: sensorReadings.id });

    const [locationRow] = await tx
      .insert(locationReadings)
      .values({
        rawPayloadId: input.rawPayloadId,
        deviceImei: location.device_imei,
        deviceId: location.device_id,
        recordedAt,
        provider: location.provider,
        deviceType: location.type,
        latitude: location.latitude,
        longitude: location.longitude,
        altitude: location.altitude,
        locationAccuracy: location.location_accuracy,
        locationAccuracyCategory: location.location_accuracy_category,
        locationSource: location.location_source,
        address: location.address as object | null,
        batteryLevel: location.battery_level,
        cellularDbm: location.cellular_dbm,
        cellularNetworkType: location.cellular_network_type,
        cellularOperator: location.cellular_operator,
        wifiAccessPoints: location.wifi_access_points,
        shipmentId: input.shipmentId,
        dataQualityFlags: flags,
      })
      .onConflictDoNothing({ target: [locationReadings.deviceImei, locationReadings.recordedAt] })
      .returning({ id: locationReadings.id });

    if (sensorRow || locationRow) {
      return { outcome: 'created', sensorId: sensorRow?.id ?? null, locationId: locationRow?.id ?? null };
    }

    /**
     * Both inserts hit the idempotency key. Whether that is a harmless retry or
     * a contradiction depends on what is already stored, so compare the
     * measurements. On a contradiction the transaction is rolled back, so the
     * device and shipment upserts above do not apply either.
     */
    const [storedSensor] = await tx
      .select()
      .from(sensorReadings)
      .where(and(eq(sensorReadings.deviceImei, sensor.device_imei), eq(sensorReadings.recordedAt, recordedAt)));
    const [storedLocation] = await tx
      .select()
      .from(locationReadings)
      .where(and(eq(locationReadings.deviceImei, location.device_imei), eq(locationReadings.recordedAt, recordedAt)));

    const incoming = measurementFingerprint({
      temperature: sensor.temperature,
      humidity: sensor.humidity,
      lightLevel: sensor.light_level,
      accelX: sensor.accelerometer?.x ?? null,
      accelY: sensor.accelerometer?.y ?? null,
      accelZ: sensor.accelerometer?.z ?? null,
      accelMagnitude: sensor.accelerometer?.magnitude ?? null,
      latitude: location.latitude,
      longitude: location.longitude,
      locationAccuracy: location.location_accuracy,
      batteryLevel: location.battery_level,
      cellularDbm: location.cellular_dbm,
      wifiAccessPoints: location.wifi_access_points,
    });

    const stored =
      storedSensor && storedLocation
        ? measurementFingerprint({ ...storedSensor, ...storedLocation })
        : null;

    if (stored !== incoming) throw new ConflictingReading();
    return { outcome: 'duplicate', sensorId: null, locationId: null };
  });
}

/**
 * The persistence contract the pipeline depends on.
 *
 * Depending on this interface rather than a live Drizzle instance is what lets
 * the ingestion pipeline be tested end-to-end -- ordering, status transitions,
 * error paths -- against an in-memory fake, with no database in the loop. It
 * also means a future queue-backed writer is a drop-in.
 */
export interface TelemetryRepository {
  insertRawPayload(input: RawPayloadInput): Promise<string>;
  finalizeRawPayload(
    id: string,
    status: IngestStatus,
    error?: { code: string; detail?: unknown },
  ): Promise<void>;
  persistReadings(input: PersistReadingsInput): Promise<PersistReadingsResult>;
}

export function createDrizzleRepository(db: DrizzleDb): TelemetryRepository {
  return {
    insertRawPayload: (input) => insertRawPayload(db, input),
    finalizeRawPayload: (id, status, error) => finalizeRawPayload(db, id, status, error),
    persistReadings: (input) => persistReadings(db, input),
  };
}
