import { describe, expect, it } from 'vitest';

import { TivePayloadSchema } from '@/lib/providers/tive/schema';
import { transformTivePayload } from '@/lib/providers/tive/transform';
import { validPayload } from './fixtures';

function transform(name: string) {
  const parsed = TivePayloadSchema.parse(validPayload(name));
  return transformTivePayload(parsed);
}

describe('Tive -> PAXAFE transform', () => {
  describe('Standard Temperature Shipment', () => {
    it('reproduces the px-sensor-schema example exactly', () => {
      const { sensor } = transform('Standard Temperature Shipment');

      // This object is copied from the "examples" block of px-sensor-schema.json.
      expect(sensor).toEqual({
        device_id: 'A571992',
        device_imei: '863257063350583',
        timestamp: 1739215646000,
        provider: 'Tive',
        type: 'Active',
        temperature: 10.08,
        humidity: 38.7,
        light_level: 0.0,
        accelerometer: { x: -0.563, y: -0.438, z: 0.688, magnitude: 0.99 },
        tilt: null,
        box_open: null,
      });
    });

    it('reproduces the px-location-schema example exactly', () => {
      const { location } = transform('Standard Temperature Shipment');

      // Copied from the "examples" block of px-location-schema.json.
      expect(location).toEqual({
        device_id: 'A571992',
        device_imei: '863257063350583',
        timestamp: 1739215646000,
        provider: 'Tive',
        type: 'Active',
        latitude: 40.810562,
        longitude: -73.879285,
        altitude: null,
        location_accuracy: 23,
        location_accuracy_category: 'High',
        location_source: 'WiFi',
        address: {
          street: null,
          locality: 'Bronx',
          state: 'NY',
          country: 'USA',
          postal_code: '10474',
          full_address: '114 Hunts Point Market, Bronx, NY 10474, USA',
        },
        battery_level: 65,
        cellular_dbm: -100.0,
        cellular_network_type: null,
        cellular_operator: null,
        wifi_access_points: 5,
      });
    });
  });

  describe('identity mapping', () => {
    it('maps DeviceName to device_id and DeviceId to device_imei, not the reverse', () => {
      const { sensor } = transform('Standard Temperature Shipment');
      expect(sensor.device_id).toBe('A571992'); // DeviceName
      expect(sensor.device_imei).toBe('863257063350583'); // DeviceId
    });

    it('gives the sensor and location records an identical correlation key', () => {
      const { sensor, location } = transform('GPS Location Shipment');
      expect([sensor.device_imei, sensor.timestamp]).toEqual([
        location.device_imei,
        location.timestamp,
      ]);
    });
  });

  describe('location source and accuracy category', () => {
    it.each([
      ['GPS Location Shipment', 'GPS', 5, 'High'],
      ['Standard Temperature Shipment', 'WiFi', 23, 'High'],
      ['Cellular Location Only', 'Cellular', 500, 'Medium'],
    ])('%s -> %s / %dm / %s', (name, source, meters, category) => {
      const { location } = transform(name as string);
      expect(location.location_source).toBe(source);
      expect(location.location_accuracy).toBe(meters);
      expect(location.location_accuracy_category).toBe(category);
    });

    it('leaves accuracy and category null when Tive omits the Accuracy block', () => {
      const { location } = transform('Minimal Data Payload');
      expect(location.location_accuracy).toBeNull();
      expect(location.location_accuracy_category).toBeNull();
      expect(location.location_source).toBeNull();
    });
  });

  describe('rounding', () => {
    it('rounds negative accelerometer axes away from zero', () => {
      // -0.5625 must become -0.563, not the -0.562 that Math.round yields.
      const { sensor } = transform('Standard Temperature Shipment');
      expect(sensor.accelerometer?.x).toBe(-0.563);
      expect(sensor.accelerometer?.y).toBe(-0.438);
    });

    it('applies the per-field precision the PX schemas specify', () => {
      const { sensor } = transform('Standard Temperature Shipment');
      // Inputs: 10.078125 / 38.70000076293945 / 0.9901862198596787
      expect(sensor.temperature).toBe(10.08); // 2dp
      expect(sensor.humidity).toBe(38.7); // 1dp
      expect(sensor.accelerometer?.magnitude).toBe(0.99); // 3dp
    });

    it('narrows float accuracy metres to an integer', () => {
      const { location } = transform('Cellular Location Only');
      expect(Number.isInteger(location.location_accuracy)).toBe(true);
    });
  });

  describe('fields Tive never provides', () => {
    it('nulls tilt, box_open, altitude and cellular network details', () => {
      const { sensor, location } = transform('Standard Temperature Shipment');
      expect(sensor.tilt).toBeNull();
      expect(sensor.box_open).toBeNull();
      expect(location.altitude).toBeNull();
      expect(location.cellular_network_type).toBeNull();
      expect(location.cellular_operator).toBeNull();
    });
  });

  describe('sparse payloads', () => {
    it('transforms a minimal payload without inventing values', () => {
      const { sensor, location } = transform('Minimal Data Payload');
      expect(sensor.temperature).toBe(22.0);
      expect(sensor.humidity).toBeNull();
      expect(sensor.light_level).toBeNull();
      expect(sensor.accelerometer).toBeNull();
      expect(location.battery_level).toBeNull();
      expect(location.cellular_dbm).toBeNull();
      expect(location.address).toBeNull();
    });
  });

  describe('data quality flags', () => {
    it('flags a DeviceName that disagrees with EntityName', () => {
      const payload = TivePayloadSchema.parse({
        ...validPayload('Standard Temperature Shipment'),
        EntityName: 'A571992',
        DeviceName: 'Ship33CABOL',
      });
      expect(transformTivePayload(payload).flags).toContain('device_name_entity_mismatch');
      // The documented mapping still wins -- we record the disagreement, not override it.
      expect(transformTivePayload(payload).sensor.device_id).toBe('Ship33CABOL');
    });

    it('flags an unrecognised location method but preserves the value', () => {
      const payload = TivePayloadSchema.parse({
        ...validPayload('Standard Temperature Shipment'),
        Location: { ...(validPayload('Standard Temperature Shipment').Location as object), LocationMethod: 'lorawan' },
      });
      const { location, flags } = transformTivePayload(payload);
      expect(flags).toContain('unknown_location_method');
      expect(location.location_source).toBe('lorawan');
    });

    it('flags a dropped probe temperature', () => {
      const payload = TivePayloadSchema.parse({
        ...validPayload('Standard Temperature Shipment'),
        ProbeTemperature: { Celsius: 4.2, Fahrenheit: 39.6 },
      });
      expect(transformTivePayload(payload).flags).toContain('probe_temperature_dropped');
    });

    it('reports no flags for a clean payload', () => {
      expect(transform('GPS Location Shipment').flags).toEqual([]);
    });
  });
});
