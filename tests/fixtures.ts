/**
 * Fixture access.
 *
 * Tests read the shipped sample file directly rather than restating payloads as
 * literals, so `schemas/sample-tive-payloads.json` stays the single source of
 * truth. If PAXAFE updates the samples, the suite exercises the new ones.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface NamedPayload {
  name: string;
  description: string;
  payload: Record<string, unknown>;
}

interface SampleFile {
  payloads: NamedPayload[];
  invalid_payloads: NamedPayload[];
}

const samples = JSON.parse(
  readFileSync(fileURLToPath(new URL('../schemas/sample-tive-payloads.json', import.meta.url)), 'utf8'),
) as SampleFile;

export const validSamples = samples.payloads;
export const invalidSamples = samples.invalid_payloads;

function pick(list: NamedPayload[], name: string): Record<string, unknown> {
  const found = list.find((p) => p.name === name);
  if (!found) throw new Error(`Fixture "${name}" not found -- did the sample file change?`);
  return found.payload;
}

export const validPayload = (name: string) => pick(validSamples, name);
export const invalidPayload = (name: string) => pick(invalidSamples, name);

export function readJsonSchema(file: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../schemas/${file}`, import.meta.url)), 'utf8'),
  );
}

/**
 * Clock pinned just after the newest valid sample. The shipped samples are
 * dated February 2025, so any real "now" would push them outside the ingestion
 * window and make the suite fail as it ages. Tests inject this instead.
 */
export const FIXTURE_NOW = Date.parse('2025-02-14T00:00:00Z');
