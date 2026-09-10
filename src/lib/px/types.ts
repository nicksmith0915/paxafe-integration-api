/**
 * PAXAFE canonical payload types.
 *
 * These mirror `schemas/px-sensor-schema.json` and `schemas/px-location-schema.json`
 * exactly. They are provider-agnostic on purpose: every provider adapter
 * (Tive today, TagnTrac/Elpro tomorrow) targets these shapes and nothing else.
 */

export const PX_PROVIDERS = [
  'Paxafe',
  'Tive',
  'TagnTrac',
  'Others',
  'Elpro',
  'kn',
  'peli',
  'tempmate',
] as const;
export type PxProvider = (typeof PX_PROVIDERS)[number];

export const PX_DEVICE_TYPES = ['Passive', 'Active', 'ELD', 'AIS', 'ADS'] as const;
export type PxDeviceType = (typeof PX_DEVICE_TYPES)[number];

export type PxAccuracyCategory = 'High' | 'Medium' | 'Low';

/** Fields shared by both canonical payloads; they form the correlation key. */
export interface PxIdentity {
  device_id: string;
  device_imei: string;
  /** Epoch milliseconds. */
  timestamp: number;
  provider: PxProvider;
  type: PxDeviceType;
}

export interface PxAccelerometer {
  x: number | null;
  y: number | null;
  z: number | null;
  magnitude: number | null;
}

export interface PxTilt {
  x: number | null;
  y: number | null;
  z: number | null;
  tilt: number | null;
}

export interface PxSensorPayload extends PxIdentity {
  temperature: number | null;
  humidity: number | null;
  light_level: number | null;
  accelerometer: PxAccelerometer | null;
  tilt: PxTilt | null;
  box_open: boolean | null;
}

export interface PxAddress {
  street: string | null;
  locality: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  full_address: string | null;
}

export interface PxLocationPayload extends PxIdentity {
  latitude: number;
  longitude: number;
  altitude: number | null;
  location_accuracy: number | null;
  location_accuracy_category: PxAccuracyCategory | null;
  location_source: string | null;
  address: PxAddress | null;
  battery_level: number | null;
  cellular_dbm: number | null;
  cellular_network_type: string | null;
  cellular_operator: string | null;
  wifi_access_points: number | null;
}

/**
 * Non-fatal observations made while transforming. These never block ingestion —
 * they are persisted alongside the reading so data quality is queryable rather
 * than buried in logs.
 */
export type DataQualityFlag =
  | 'device_name_entity_mismatch'
  | 'unknown_location_method'
  | 'address_unparsed'
  | 'probe_temperature_dropped'
  | 'null_primary_temperature';
