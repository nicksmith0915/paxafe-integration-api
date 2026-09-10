/**
 * Persistence layer.
 *
 * The only module that knows SQL. Everything above it deals in canonical PX
 * types, so swapping the storage engine or adding a provider touches nothing
 * here beyond the shipment/device context helpers.
 */

import { sql } from 'drizzle-orm';

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
      body: input.body as object,
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

export interface PersistReadingsResult {
  sensorId: string | null;
  locationId: string | null;
  /** True when the unique (device_imei, recorded_at) key already existed. */
  duplicate: boolean;
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
  const { sensor, location, flags } = input;
  const recordedAt = new Date(sensor.timestamp);

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

    return {
      sensorId: sensorRow?.id ?? null,
      locationId: locationRow?.id ?? null,
      duplicate: !sensorRow && !locationRow,
    };
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
