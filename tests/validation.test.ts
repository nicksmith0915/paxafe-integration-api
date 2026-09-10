/**
 * Every payload the exercise ships under `invalid_payloads` gets a named case
 * here, together with the reason it is rejected and at which layer.
 */

import { describe, expect, it } from 'vitest';

import { checkTimestampWindow } from '@/lib/ingest/timestamp';
import { TivePayloadSchema } from '@/lib/providers/tive/schema';
import { FIXTURE_NOW, invalidPayload, validPayload } from './fixtures';

const WINDOW = { maxAgeDays: 90, maxFutureSkewMinutes: 60 };

function issuePaths(payload: unknown): string[] {
  const result = TivePayloadSchema.safeParse(payload);
  if (result.success) return [];
  return result.error.issues.map((i) => i.path.join('.'));
}

describe('schema validation rejects malformed payloads', () => {
  it('Missing Device Identifiers - Scenario A: no DeviceId (IMEI)', () => {
    const paths = issuePaths(invalidPayload('Missing Device Identifiers - Scenario A'));
    expect(paths).toContain('DeviceId');
  });

  it('Missing Device Identifiers - Scenario B: no DeviceId, and DeviceName is shipment-like', () => {
    const payload = invalidPayload('Missing Device Identifiers - Scenario B');
    // Rejected for the same structural reason as Scenario A: device_imei is
    // required by both PX formats and has no fallback source.
    expect(issuePaths(payload)).toContain('DeviceId');
    // The distinguishing feature of this fixture is that DeviceName ("Ship33CABOL")
    // disagrees with EntityName ("A571992") -- handled as a data-quality flag in
    // the transform, not as a mapping override. See transform.test.ts.
    expect(payload.DeviceName).not.toBe(payload.EntityName);
  });

  it('Invalid Latitude: outside -90..90', () => {
    expect(issuePaths(invalidPayload('Invalid Latitude'))).toContain('Location.Latitude');
  });

  it('Invalid Longitude: outside -180..180', () => {
    expect(issuePaths(invalidPayload('Invalid Longitude'))).toContain('Location.Longitude');
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const result = TivePayloadSchema.safeParse({
      DeviceName: 'A571992',
      EntryTimeEpoch: 1739215646000,
      Temperature: { Celsius: 10 },
      Location: { Latitude: 95, Longitude: -200 },
    });
    expect(result.success).toBe(false);
    // Missing DeviceId + bad latitude + bad longitude.
    expect(result.error!.issues.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a DeviceId that is not a 15-digit IMEI', () => {
    const paths = issuePaths({ ...validPayload('Standard Temperature Shipment'), DeviceId: '12345' });
    expect(paths).toContain('DeviceId');
  });
});

describe('ingestion window is policy, not schema', () => {
  it.each([
    ['Timestamp in Future', 'in the future'],
    ['Old Timestamp', 'ingestion window'],
  ])('%s is schema-valid but rejected by policy', (name, expectedMessage) => {
    const payload = invalidPayload(name) as Record<string, unknown> & { EntryTimeEpoch: number };

    // Both fixtures satisfy the Tive schema itself...
    const withImei = { ...payload, DeviceId: '863257063350583' };
    expect(TivePayloadSchema.safeParse(withImei).success).toBe(true);

    // ...and are rejected only by the configured window.
    const issues = checkTimestampWindow(payload.EntryTimeEpoch, FIXTURE_NOW, WINDOW);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('EntryTimeEpoch');
    expect(issues[0].message).toContain(expectedMessage);
  });

  it('accepts every valid sample under the same window', () => {
    for (const name of [
      'Standard Temperature Shipment',
      'GPS Location Shipment',
      'Cellular Location Only',
      'Minimal Data Payload',
    ]) {
      const payload = validPayload(name) as { EntryTimeEpoch: number };
      expect(
        checkTimestampWindow(payload.EntryTimeEpoch, FIXTURE_NOW, WINDOW),
        `${name} should be inside the window`,
      ).toEqual([]);
    }
  });

  it('tolerates small clock skew but not large future drift', () => {
    const now = FIXTURE_NOW;
    expect(checkTimestampWindow(now + 30 * 60_000, now, WINDOW)).toEqual([]);
    expect(checkTimestampWindow(now + 120 * 60_000, now, WINDOW)).toHaveLength(1);
  });
});
