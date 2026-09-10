import { describe, expect, it } from 'vitest';

import {
  ACCURACY_HIGH_MAX_METERS,
  ACCURACY_MEDIUM_MAX_METERS,
  accuracyCategory,
  normalizeLocationSource,
  parseFormattedAddress,
  roundTo,
} from '@/lib/px/policy';

describe('roundTo', () => {
  it('rounds halves away from zero in both directions', () => {
    expect(roundTo(0.6875, 3)).toBe(0.688);
    expect(roundTo(-0.5625, 3)).toBe(-0.563);
    expect(roundTo(-0.4375, 3)).toBe(-0.438);
  });

  it('corrects float representation drift', () => {
    expect(roundTo(38.70000076293945, 1)).toBe(38.7);
    expect(roundTo(10.078125, 2)).toBe(10.08);
    expect(roundTo(1.005, 2)).toBe(1.01);
  });

  it('passes null-ish and non-finite input through as null', () => {
    expect(roundTo(null, 2)).toBeNull();
    expect(roundTo(undefined, 2)).toBeNull();
    expect(roundTo(Number.NaN, 2)).toBeNull();
    expect(roundTo(Number.POSITIVE_INFINITY, 2)).toBeNull();
  });

  it('never returns negative zero', () => {
    expect(Object.is(roundTo(-0.0001, 2), 0)).toBe(true);
  });
});

describe('accuracyCategory', () => {
  it('matches the anchor given in px-location-schema.json (23m -> High)', () => {
    expect(accuracyCategory(23)).toBe('High');
  });

  it('is inclusive at each boundary', () => {
    expect(accuracyCategory(ACCURACY_HIGH_MAX_METERS)).toBe('High');
    expect(accuracyCategory(ACCURACY_HIGH_MAX_METERS + 1)).toBe('Medium');
    expect(accuracyCategory(ACCURACY_MEDIUM_MAX_METERS)).toBe('Medium');
    expect(accuracyCategory(ACCURACY_MEDIUM_MAX_METERS + 1)).toBe('Low');
  });

  it('returns null when accuracy is unknown or nonsensical', () => {
    expect(accuracyCategory(null)).toBeNull();
    expect(accuracyCategory(-1)).toBeNull();
  });
});

describe('normalizeLocationSource', () => {
  it.each([
    ['gps', 'GPS'],
    ['wifi', 'WiFi'],
    ['cell', 'Cellular'],
    ['WIFI', 'WiFi'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeLocationSource(input)).toEqual({ source: expected, known: true });
  });

  it('preserves an unrecognised method and reports it as unknown', () => {
    expect(normalizeLocationSource('lorawan')).toEqual({ source: 'lorawan', known: false });
  });

  it('treats absent and blank values as simply unknown location', () => {
    expect(normalizeLocationSource(null)).toEqual({ source: null, known: true });
    expect(normalizeLocationSource('  ')).toEqual({ source: null, known: true });
  });
});

describe('parseFormattedAddress', () => {
  it('decomposes a US address into components', () => {
    const { address } = parseFormattedAddress('114 Hunts Point Market, Bronx, NY 10474, USA');
    expect(address).toEqual({
      // Never inferred: the leading segment here is a venue, not a street.
      street: null,
      locality: 'Bronx',
      state: 'NY',
      postal_code: '10474',
      country: 'USA',
      full_address: '114 Hunts Point Market, Bronx, NY 10474, USA',
    });
  });

  it('handles a city-level US address', () => {
    const { address } = parseFormattedAddress('Boston, MA 02101, USA');
    expect(address).toMatchObject({ locality: 'Boston', state: 'MA', postal_code: '02101' });
  });

  it('handles ZIP+4', () => {
    const { address } = parseFormattedAddress('Somewhere, CA 94102-1234, USA');
    expect(address).toMatchObject({ postal_code: '94102-1234', state: 'CA' });
  });

  it('handles a non-US address without inventing a state or postal code', () => {
    const { address } = parseFormattedAddress('London, UK');
    expect(address).toMatchObject({
      locality: 'London',
      country: 'UK',
      state: null,
      postal_code: null,
    });
  });

  it('always preserves the original text verbatim', () => {
    const input = 'Somewhere Unparseable';
    const { address, parsed } = parseFormattedAddress(input);
    expect(address?.full_address).toBe(input);
    expect(parsed).toBe(false);
  });

  it('returns null for an absent address rather than an empty shell', () => {
    expect(parseFormattedAddress(null).address).toBeNull();
    expect(parseFormattedAddress('   ').address).toBeNull();
  });
});
