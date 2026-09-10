/**
 * Interpretation policy for the PAXAFE canonical format.
 *
 * Everything here is a decision that the provided schemas leave open. Each is
 * documented with its rationale because the mapping is otherwise unfalsifiable:
 * the schemas specify shapes, not the judgement calls between them.
 */

import type { PxAccuracyCategory, PxAddress } from './types';

/**
 * The PX schemas specify decimal precision per field ("2 decimal points",
 * "1 decimal point", ...). Tive sends full float precision
 * (e.g. 38.70000076293945), so rounding is part of the output contract.
 */
export function roundTo(value: number | null | undefined, decimals: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  const scaled = value * factor;
  /**
   * Half-away-from-zero, not `Math.round`. `Math.round` breaks ties toward
   * positive infinity, so an accelerometer reading of -0.5625 would round to
   * -0.562 -- while px-sensor-schema.json's own example requires -0.563.
   * Negative sensor axes are common, so the difference is not academic.
   *
   * The epsilon nudge is *relative*, not additive. Decimal literals are not
   * exactly representable, so a value that reads as an exact tie often is not:
   * 1.005 * 100 evaluates to 100.49999999999999 and would round down. Adding
   * Number.EPSILON cannot fix that -- it is relative to 1.0 and vanishes at
   * magnitude 100 -- whereas scaling by (1 + EPSILON) corrects the drift at any
   * magnitude while being far too small to move a value that is not already at
   * the boundary.
   */
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled) * (1 + Number.EPSILON));
  const result = rounded / factor;
  // Normalise -0 to 0 so equality checks and JSON output stay predictable.
  return result === 0 ? 0 : result;
}

/**
 * `location_accuracy_category` exists in the PX schema with no corresponding
 * Tive field, so it must be derived from the accuracy radius.
 *
 * The only fixed point given is the PX example: 23 m -> "High". The thresholds
 * below are chosen to match that anchor and to separate the three location
 * technologies Tive reports, which have materially different error radii:
 *   GPS/GNSS    ~5 m      -> High
 *   WiFi        ~20-50 m  -> High
 *   Cell tower  ~500 m+   -> Medium/Low
 * Boundaries are inclusive of the upper bound.
 */
export const ACCURACY_HIGH_MAX_METERS = 50;
export const ACCURACY_MEDIUM_MAX_METERS = 500;

export function accuracyCategory(meters: number | null): PxAccuracyCategory | null {
  if (meters === null || !Number.isFinite(meters) || meters < 0) return null;
  if (meters <= ACCURACY_HIGH_MAX_METERS) return 'High';
  if (meters <= ACCURACY_MEDIUM_MAX_METERS) return 'Medium';
  return 'Low';
}

/**
 * Tive sends lowercase method codes; PX examples use display casing ("WiFi").
 * Unknown values are passed through untouched rather than nulled — a new Tive
 * location method should degrade to "unrecognised but recorded", not data loss.
 */
const LOCATION_SOURCE_MAP: Record<string, string> = {
  gps: 'GPS',
  wifi: 'WiFi',
  cell: 'Cellular',
};

export function normalizeLocationSource(method: string | null | undefined): {
  source: string | null;
  known: boolean;
} {
  if (method === null || method === undefined || method.trim() === '') {
    return { source: null, known: true };
  }
  const mapped = LOCATION_SOURCE_MAP[method.trim().toLowerCase()];
  return mapped ? { source: mapped, known: true } : { source: method, known: false };
}

/** Matches a US-style "ST 12345" or "ST 12345-6789" locality line. */
const US_STATE_ZIP = /^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/;

/**
 * Tive supplies only a flat `FormattedAddress`; the PX schema wants it broken
 * into components. This is a best-effort parse of comma-separated address text
 * and it deliberately fails soft: `full_address` is always preserved verbatim,
 * and any component that cannot be identified stays null rather than guessed.
 *
 * `street` is intentionally never inferred. Tive's formatted address is
 * geocoder output (the samples carry `GeolocationSourceName: "skyhook"`), whose
 * leading segment is frequently a POI or venue name rather than a street line --
 * "114 Hunts Point Market" in the shipped sample. px-location-schema.json's own
 * example leaves `street` null for exactly that address while populating every
 * other component, so writing a venue name there would contradict the target
 * contract. Nothing is lost: the full text is retained in `full_address`.
 */
export function parseFormattedAddress(formatted: string | null | undefined): {
  address: PxAddress | null;
  parsed: boolean;
} {
  if (formatted === null || formatted === undefined || formatted.trim() === '') {
    return { address: null, parsed: true };
  }

  const full = formatted.trim();
  const parts = full
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const address: PxAddress = {
    street: null,
    locality: null,
    state: null,
    country: null,
    postal_code: null,
    full_address: full,
  };

  if (parts.length < 2) {
    // A single token tells us nothing structural; keep only the full address.
    return { address, parsed: false };
  }

  address.country = parts[parts.length - 1];
  const remaining = parts.slice(0, -1);

  const stateZipIndex = remaining.findIndex((p) => US_STATE_ZIP.test(p));
  if (stateZipIndex !== -1) {
    const [, state, postal] = US_STATE_ZIP.exec(remaining[stateZipIndex])!;
    address.state = state;
    address.postal_code = postal;
    if (stateZipIndex > 0) address.locality = remaining[stateZipIndex - 1];
    return { address, parsed: true };
  }

  // No recognisable state/postal line: treat the last remaining part as the
  // locality. Anything ahead of it is street/venue detail we do not classify.
  address.locality = remaining[remaining.length - 1] ?? null;
  return { address, parsed: true };
}
