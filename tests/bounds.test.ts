/**
 * The plausibility bounds are what stop an out-of-range sensor value reaching
 * the database, where a numeric overflow would reject the entire reading. That
 * only holds if every bound fits its column, so it is asserted against the
 * schema itself: widening a bound or narrowing a column without the other
 * fails here instead of in production.
 */

import { describe, expect, it } from 'vitest';

import { locationReadings, sensorReadings } from '@/lib/db/schema';
import { PLAUSIBLE_RANGES, type Range } from '@/lib/px/policy';

const INT4_MAX = 2_147_483_647;

/**
 * A numeric(p, s) column holds magnitudes strictly below 10^(p - s). Drizzle
 * keeps precision and scale on the column at runtime without exposing them in
 * the public column type, hence the narrowing.
 */
function numericCapacity(column: unknown): number {
  const { precision, scale } = column as { precision?: number; scale?: number };
  if (precision === undefined || scale === undefined) {
    throw new Error('numeric column must declare precision and scale');
  }
  return 10 ** (precision - scale);
}

const largestMagnitude = (range: Range) => Math.max(Math.abs(range.min), Math.abs(range.max));

describe('plausibility bounds fit their database columns', () => {
  it.each([
    ['temperature', sensorReadings.temperature, PLAUSIBLE_RANGES.temperature],
    ['humidity', sensorReadings.humidity, PLAUSIBLE_RANGES.humidity],
    ['light_level', sensorReadings.lightLevel, PLAUSIBLE_RANGES.light_level],
    ['accel_x', sensorReadings.accelX, PLAUSIBLE_RANGES.accelerometer],
    ['accel_y', sensorReadings.accelY, PLAUSIBLE_RANGES.accelerometer],
    ['accel_z', sensorReadings.accelZ, PLAUSIBLE_RANGES.accelerometer],
    ['accel_magnitude', sensorReadings.accelMagnitude, PLAUSIBLE_RANGES.accelerometer],
    ['cellular_dbm', locationReadings.cellularDbm, PLAUSIBLE_RANGES.cellular_dbm],
  ])('%s', (_name, column, range) => {
    expect(largestMagnitude(range)).toBeLessThan(numericCapacity(column));
  });

  it.each([
    ['battery_level', PLAUSIBLE_RANGES.battery_level],
    ['location_accuracy', PLAUSIBLE_RANGES.location_accuracy],
    ['wifi_access_points', PLAUSIBLE_RANGES.wifi_access_points],
  ])('%s fits a 32-bit integer', (_name, range) => {
    expect(largestMagnitude(range)).toBeLessThanOrEqual(INT4_MAX);
  });
});
