/**
 * Database schema.
 *
 * Shape of the design:
 *
 *   raw_payloads         every request body, stored before validation
 *     |-> sensor_readings      canonical PX sensor record
 *     `-> location_readings    canonical PX location record
 *   devices / shipments  slowly-changing context, upserted from telemetry
 *
 * `raw_payloads` is written first and unconditionally, so a transform bug is a
 * replayable row rather than lost data, and rejected payloads stay inspectable.
 * The two reading tables hold exactly the canonical PX fields -- anything
 * Tive-specific stays in the raw body.
 *
 * Sensor values use `numeric` rather than float: readings are compared against
 * regulatory temperature excursion thresholds, where float drift is not
 * acceptable. Coordinates use double precision, the conventional choice for
 * lat/lon and what PostGIS would expect later.
 */

import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const INGEST_STATUS = ['processed', 'duplicate', 'rejected', 'failed'] as const;
export type IngestStatus = (typeof INGEST_STATUS)[number];

export const devices = pgTable(
  'devices',
  {
    /** PX `device_imei` -- the stable hardware identity, and the natural key. */
    deviceImei: text('device_imei').primaryKey(),
    /** PX `device_id`, from Tive's user-programmable DeviceName. Mutable. */
    deviceId: text('device_id').notNull(),
    provider: text('provider').notNull(),
    deviceType: text('device_type').notNull(),
    accountId: integer('account_id'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('devices_account_idx').on(t.accountId)],
);

export const shipments = pgTable(
  'shipments',
  {
    shipmentId: text('shipment_id').primaryKey(),
    publicShipmentId: text('public_shipment_id'),
    description: text('description'),
    carrier: text('carrier'),
    /** Origin/destination kept as JSON: not queried on, and provider-shaped. */
    shipFrom: jsonb('ship_from'),
    shipTo: jsonb('ship_to'),
    accountId: integer('account_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('shipments_public_id_idx').on(t.publicShipmentId)],
);

export const rawPayloads = pgTable(
  'raw_payloads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Correlates the stored row with the log line and the client's response. */
    requestId: text('request_id').notNull(),
    provider: text('provider').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    body: jsonb('body').notNull(),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    errorDetail: jsonb('error_detail'),
    /** Best-effort: populated even for rejects when the field could be read. */
    deviceImei: text('device_imei'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }),
  },
  (t) => [
    // Supports the two operational questions: "what failed recently?" and
    // "show me everything this device sent".
    index('raw_payloads_status_received_idx').on(t.status, t.receivedAt),
    index('raw_payloads_device_idx').on(t.deviceImei, t.receivedAt),
  ],
);

export const sensorReadings = pgTable(
  'sensor_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rawPayloadId: uuid('raw_payload_id').references(() => rawPayloads.id, { onDelete: 'set null' }),

    deviceImei: text('device_imei').notNull(),
    deviceId: text('device_id').notNull(),
    /**
     * PX emits epoch milliseconds; Postgres stores an instant. Converted at the
     * boundary so the database stays queryable with ordinary date predicates.
     */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    provider: text('provider').notNull(),
    deviceType: text('device_type').notNull(),

    temperature: numeric('temperature', { precision: 6, scale: 2, mode: 'number' }),
    humidity: numeric('humidity', { precision: 4, scale: 1, mode: 'number' }),
    lightLevel: numeric('light_level', { precision: 10, scale: 1, mode: 'number' }),

    accelX: numeric('accel_x', { precision: 7, scale: 3, mode: 'number' }),
    accelY: numeric('accel_y', { precision: 7, scale: 3, mode: 'number' }),
    accelZ: numeric('accel_z', { precision: 7, scale: 3, mode: 'number' }),
    accelMagnitude: numeric('accel_magnitude', { precision: 7, scale: 3, mode: 'number' }),

    /** Never populated by Tive; kept so the table matches the PX contract. */
    tilt: jsonb('tilt'),
    boxOpen: boolean('box_open'),

    shipmentId: text('shipment_id'),
    dataQualityFlags: text('data_quality_flags').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * Idempotency key. Webhook senders retry on timeout, so the same reading
     * arrives more than once; a device cannot have two different readings for
     * the same instant. Inserts use ON CONFLICT DO NOTHING against this.
     */
    uniqueIndex('sensor_readings_device_time_key').on(t.deviceImei, t.recordedAt),
    // "Latest readings for this device/shipment" is the dominant read pattern.
    index('sensor_readings_device_recent_idx').on(t.deviceImei, t.recordedAt.desc()),
    index('sensor_readings_shipment_idx').on(t.shipmentId, t.recordedAt.desc()),
  ],
);

export const locationReadings = pgTable(
  'location_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rawPayloadId: uuid('raw_payload_id').references(() => rawPayloads.id, { onDelete: 'set null' }),

    deviceImei: text('device_imei').notNull(),
    deviceId: text('device_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    provider: text('provider').notNull(),
    deviceType: text('device_type').notNull(),

    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    altitude: numeric('altitude', { precision: 9, scale: 2, mode: 'number' }),

    locationAccuracy: integer('location_accuracy'),
    locationAccuracyCategory: text('location_accuracy_category'),
    locationSource: text('location_source'),

    /** Address components, stored as the PX sub-object rather than flattened. */
    address: jsonb('address'),

    batteryLevel: integer('battery_level'),
    cellularDbm: numeric('cellular_dbm', { precision: 6, scale: 2, mode: 'number' }),
    cellularNetworkType: text('cellular_network_type'),
    cellularOperator: text('cellular_operator'),
    wifiAccessPoints: integer('wifi_access_points'),

    shipmentId: text('shipment_id'),
    dataQualityFlags: text('data_quality_flags').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('location_readings_device_time_key').on(t.deviceImei, t.recordedAt),
    index('location_readings_device_recent_idx').on(t.deviceImei, t.recordedAt.desc()),
    index('location_readings_shipment_idx').on(t.shipmentId, t.recordedAt.desc()),
  ],
);
