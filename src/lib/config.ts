/**
 * Environment configuration.
 *
 * Parsed lazily and cached: importing this module must never throw, so that
 * pure units (transform, policy) stay testable without any environment at all.
 */

import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),

  /**
   * Comma-separated API keys. Multiple keys are supported so that a key can be
   * rotated without downtime: add the new one, migrate senders, drop the old.
   */
  API_KEYS: z
    .string()
    .min(1)
    .transform((raw) =>
      raw
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0),
    )
    .refine((keys) => keys.length > 0, 'API_KEYS must contain at least one key'),

  /**
   * Ingestion acceptance window. Telemetry outside it is rejected as a policy
   * decision, not a schema violation -- see docs/DECISIONS.md.
   */
  TELEMETRY_MAX_AGE_DAYS: z.coerce.number().positive().default(90),
  TELEMETRY_MAX_FUTURE_SKEW_MINUTES: z.coerce.number().positive().default(60),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration -- ${detail}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test seam: drop the memoised config so env changes take effect. */
export function resetConfigCache(): void {
  cached = null;
}
