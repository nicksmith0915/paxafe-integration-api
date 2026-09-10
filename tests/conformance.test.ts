/**
 * Schema conformance.
 *
 * The transform tests assert what we *think* the output should be. These assert
 * that the output satisfies PAXAFE's published JSON Schemas, validated by ajv.
 * That turns "integration accuracy" into something the suite proves rather than
 * something the README claims.
 */

import Ajv2020 from 'ajv';
import addFormats from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';

import { TivePayloadSchema } from '@/lib/providers/tive/schema';
import { transformTivePayload } from '@/lib/providers/tive/transform';
import { readJsonSchema, validSamples } from './fixtures';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

let validateSensor: ReturnType<typeof ajv.compile>;
let validateLocation: ReturnType<typeof ajv.compile>;

beforeAll(() => {
  validateSensor = ajv.compile(readJsonSchema('px-sensor-schema.json'));
  validateLocation = ajv.compile(readJsonSchema('px-location-schema.json'));
});

describe('canonical output conformance', () => {
  it.each(validSamples.map((s) => [s.name, s.payload] as const))(
    '%s produces a schema-valid sensor and location record',
    (_name, payload) => {
      const parsed = TivePayloadSchema.parse(payload);
      const { sensor, location } = transformTivePayload(parsed);

      // Round-trip through JSON: this is what actually leaves the process.
      const sensorOk = validateSensor(JSON.parse(JSON.stringify(sensor)));
      expect(validateSensor.errors ?? []).toEqual([]);
      expect(sensorOk).toBe(true);

      const locationOk = validateLocation(JSON.parse(JSON.stringify(location)));
      expect(validateLocation.errors ?? []).toEqual([]);
      expect(locationOk).toBe(true);
    },
  );
});

describe('input fixtures match the published Tive schema', () => {
  it('accepts every sample the exercise labels valid', () => {
    for (const sample of validSamples) {
      const result = TivePayloadSchema.safeParse(sample.payload);
      expect(result.success, `${sample.name}: ${result.error?.message}`).toBe(true);
    }
  });
});
