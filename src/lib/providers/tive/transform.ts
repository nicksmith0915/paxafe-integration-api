/**
 * Tive -> PAXAFE transformation.
 *
 * Pure: no I/O, no clock, no environment. One Tive payload fans out to exactly
 * two canonical records that share an identity block, so a sensor reading and
 * the location it was taken at remain joinable on
 * (device_imei, timestamp).
 */

import {
  accuracyCategory,
  normalizeLocationSource,
  parseFormattedAddress,
  roundTo,
} from '@/lib/px/policy';
import type {
  DataQualityFlag,
  PxLocationPayload,
  PxSensorPayload,
} from '@/lib/px/types';
import type { TivePayload } from './schema';

/** Every reading from this adapter is a Tive real-time (active) tracker. */
const PROVIDER = 'Tive' as const;
const DEVICE_TYPE = 'Active' as const;

export interface TiveTransformResult {
  sensor: PxSensorPayload;
  location: PxLocationPayload;
  flags: DataQualityFlag[];
}

export function transformTivePayload(input: TivePayload): TiveTransformResult {
  const flags: DataQualityFlag[] = [];

  /**
   * `device_id` comes from DeviceName (stated in px-sensor-schema.json) and
   * `device_imei` from DeviceId, which is the 15-digit IMEI. The two Tive
   * fields read like synonyms but map to opposite PX fields -- inverting them
   * is the single easiest way to corrupt this integration.
   *
   * DeviceName is user-programmable, so it can drift from EntityName (one
   * sample carries the shipment-ish name "Ship33CABOL"). We keep the documented
   * mapping rather than second-guessing it with heuristics, but record the
   * disagreement so it is queryable.
   */
  if (input.EntityName && input.EntityName !== input.DeviceName) {
    flags.push('device_name_entity_mismatch');
  }

  const identity = {
    device_id: input.DeviceName,
    device_imei: input.DeviceId,
    timestamp: input.EntryTimeEpoch,
    provider: PROVIDER,
    type: DEVICE_TYPE,
  };

  // --- Sensor ---------------------------------------------------------------

  const temperature = roundTo(input.Temperature.Celsius, 2);
  if (temperature === null) flags.push('null_primary_temperature');

  /**
   * PX has no field for the external probe. Dropping it is lossy, so the raw
   * payload is retained in `raw_payloads` and the drop is flagged rather than
   * silently discarded.
   */
  if (input.ProbeTemperature?.Celsius !== null && input.ProbeTemperature?.Celsius !== undefined) {
    flags.push('probe_temperature_dropped');
  }

  const accel = input.Accelerometer;
  const sensor: PxSensorPayload = {
    ...identity,
    temperature,
    humidity: roundTo(input.Humidity?.Percentage, 1),
    light_level: roundTo(input.Light?.Lux, 1),
    accelerometer: accel
      ? {
          x: roundTo(accel.X, 3),
          y: roundTo(accel.Y, 3),
          z: roundTo(accel.Z, 3),
          // Tive reports the gravitational magnitude as `G`.
          magnitude: roundTo(accel.G, 3),
        }
      : null,
    // Tive trackers report neither tilt angles nor a box-open contact.
    tilt: null,
    box_open: null,
  };

  // --- Location -------------------------------------------------------------

  const { source, known } = normalizeLocationSource(input.Location.LocationMethod);
  if (!known) flags.push('unknown_location_method');

  /**
   * PX types accuracy as an integer while Tive sends a float, so this narrows
   * rather than merely rounds.
   */
  const accuracyMeters =
    input.Location.Accuracy?.Meters === null || input.Location.Accuracy?.Meters === undefined
      ? null
      : Math.round(input.Location.Accuracy.Meters);

  const { address, parsed } = parseFormattedAddress(input.Location.FormattedAddress);
  if (address && !parsed) flags.push('address_unparsed');

  const location: PxLocationPayload = {
    ...identity,
    latitude: input.Location.Latitude,
    longitude: input.Location.Longitude,
    // Not reported by Tive.
    altitude: null,
    location_accuracy: accuracyMeters,
    location_accuracy_category: accuracyCategory(accuracyMeters),
    location_source: source,
    address,
    battery_level: input.Battery?.Percentage ?? null,
    cellular_dbm: roundTo(input.Cellular?.Dbm, 2),
    // Tive's webhook carries signal strength but no network type or operator.
    cellular_network_type: null,
    cellular_operator: null,
    wifi_access_points: input.Location.WifiAccessPointUsedCount ?? null,
  };

  return { sensor, location, flags };
}
