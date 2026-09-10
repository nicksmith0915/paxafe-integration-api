/**
 * Ingestion window policy.
 *
 * Neither of the two timestamp cases in `sample-tive-payloads.json` violates the
 * Tive JSON Schema -- both are integers >= 0. The schema's only constraint is
 * `minimum: 0`, so rejecting a 2030 or a 2021 reading is a *policy* decision,
 * and it is made here rather than in the schema layer so it stays visible,
 * configurable and independently testable.
 *
 * Why reject at all:
 *  - Future timestamps corrupt "latest known state" queries. A single reading
 *    dated 2030 pins a shipment's most-recent position for years.
 *  - Very old timestamps usually mean a device flushed a stale buffer after
 *    reconnecting. They are real data, but silently interleaving them into a
 *    live shipment timeline misrepresents current conditions.
 *
 * Both bounds are configurable, and rejected payloads are still persisted to
 * `raw_payloads` so nothing is lost and anything can be re-driven after the
 * window is widened.
 */

import type { FieldIssue } from './errors';

export interface IngestionWindow {
  maxAgeDays: number;
  maxFutureSkewMinutes: number;
}

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

export function checkTimestampWindow(
  epochMs: number,
  now: number,
  window: IngestionWindow,
): FieldIssue[] {
  const futureLimit = now + window.maxFutureSkewMinutes * MS_PER_MINUTE;
  const pastLimit = now - window.maxAgeDays * MS_PER_DAY;

  if (epochMs > futureLimit) {
    return [
      {
        path: 'EntryTimeEpoch',
        message:
          `Timestamp ${new Date(epochMs).toISOString()} is more than ` +
          `${window.maxFutureSkewMinutes} minutes in the future.`,
      },
    ];
  }

  if (epochMs < pastLimit) {
    return [
      {
        path: 'EntryTimeEpoch',
        message:
          `Timestamp ${new Date(epochMs).toISOString()} is older than the ` +
          `${window.maxAgeDays}-day ingestion window.`,
      },
    ];
  }

  return [];
}

/**
 * Cross-check between the two timestamps Tive sends. `EntryTimeEpoch` is
 * authoritative; a disagreeing `EntryTimeUtc` is worth surfacing but is never
 * grounds for rejection.
 */
export function utcMatchesEpoch(entryTimeUtc: string | null | undefined, epochMs: number): boolean {
  if (!entryTimeUtc) return true;
  const parsed = Date.parse(entryTimeUtc);
  if (Number.isNaN(parsed)) return false;
  // Tive's ISO string is second-resolution; allow sub-second disagreement.
  return Math.abs(parsed - epochMs) < 1000;
}
