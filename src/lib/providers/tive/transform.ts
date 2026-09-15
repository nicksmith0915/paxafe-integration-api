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
  PLAUSIBLE_RANGES,
  roundTo,
  withinRange,
  type Range,
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

  /** Keeps a value inside its plausible range, or nulls it and records why. */
  const bounded = (value: number | null, range: Range, flag: DataQualityFlag): number | null => {
    const result = withinRange(value, range);
    if (result.outOfRange && !flags.includes(flag)) flags.push(flag);
    return result.value;
  };

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

  // Distinguish "Tive sent no temperature" from "Tive sent an impossible one".
  const reportedTemperature = roundTo(input.Temperature.Celsius, 2);
  if (reportedTemperature === null) flags.push('null_primary_temperature');
  const temperature = bounded(reportedTemperature, PLAUSIBLE_RANGES.temperature, 'temperature_out_of_range');

  /**
   * PX has no field for the external probe. Dropping it is lossy, so the raw
   * payload is retained in `raw_payloads` and the drop is flagged rather than
   * silently discarded.
   */
  if (input.ProbeTemperature?.Celsius !== null && input.ProbeTemperature?.Celsius !== undefined) {
    flags.push('probe_temperature_dropped');
  }

  const accel = input.Accelerometer;
  const axis = (value: number | null | undefined) =>
    bounded(roundTo(value, 3), PLAUSIBLE_RANGES.accelerometer, 'accelerometer_out_of_range');

  const sensor: PxSensorPayload = {
    ...identity,
    temperature,
    humidity: bounded(roundTo(input.Humidity?.Percentage, 1), PLAUSIBLE_RANGES.humidity, 'humidity_out_of_range'),
    light_level: bounded(roundTo(input.Light?.Lux, 1), PLAUSIBLE_RANGES.light_level, 'light_level_out_of_range'),
    accelerometer: accel
      ? {
          x: axis(accel.X),
          y: axis(accel.Y),
          z: axis(accel.Z),
          // Tive reports the gravitational magnitude as `G`.
          magnitude: axis(accel.G),
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
   * Exactly (0, 0) is a valid coordinate and a well-known failure signature: a
   * tracker with no fix often reports zeroes, which places a shipment in the
   * Gulf of Guinea. It is stored as reported -- PX requires coordinates, and
   * substituting a guess would be worse -- but flagged so it can be excluded
   * from mapping and geofencing.
   */
  if (input.Location.Latitude === 0 && input.Location.Longitude === 0) {
    flags.push('null_island_coordinates');
  }

  /**
   * PX types accuracy as an integer while Tive sends a float, so this narrows
   * rather than merely rounds. A negative or planet-sized radius is nulled, and
   * the derived category follows it.
   */
  const accuracyMeters = bounded(
    roundTo(input.Location.Accuracy?.Meters, 0),
    PLAUSIBLE_RANGES.location_accuracy,
    'location_accuracy_out_of_range',
  );

  const { address, parsed } = parseFormattedAddress(input.Location.FormattedAddress);
  if (address && !parsed) flags.push('address_unparsed');

  /**
   * PX battery is an integer percentage. A fractional value is a precision
   * difference, not a fault, so it is rounded and flagged; a value outside
   * 0-100 cannot be true and is nulled.
   */
  let batteryLevel = bounded(input.Battery?.Percentage ?? null, PLAUSIBLE_RANGES.battery_level, 'battery_out_of_range');
  if (batteryLevel !== null && !Number.isInteger(batteryLevel)) {
    batteryLevel = roundTo(batteryLevel, 0);
    flags.push('battery_rounded');
  }

  /** A count cannot be fractional or negative; rounding one would invent a scan. */
  const wifiReported = input.Location.WifiAccessPointUsedCount ?? null;
  const wifiAccessPoints =
    wifiReported === null
      ? null
      : Number.isInteger(wifiReported) &&
          withinRange(wifiReported, PLAUSIBLE_RANGES.wifi_access_points).outOfRange === false
        ? wifiReported
        : (flags.push('wifi_access_points_invalid'), null);

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
    battery_level: batteryLevel,
    cellular_dbm: bounded(roundTo(input.Cellular?.Dbm, 2), PLAUSIBLE_RANGES.cellular_dbm, 'cellular_dbm_out_of_range'),
    // Tive's webhook carries signal strength but no network type or operator.
    cellular_network_type: null,
    cellular_operator: null,
    wifi_access_points: wifiAccessPoints,
  };

  return { sensor, location, flags };
}
