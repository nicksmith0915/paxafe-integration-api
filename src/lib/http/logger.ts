/**
 * Structured logging.
 *
 * One JSON object per line, which is what Vercel's log drains and every log
 * aggregator expect. Human-readable prose in logs is unqueryable; the fields
 * here are chosen so that "show me rejects for this device today" is a filter
 * rather than a grep.
 *
 * `request_id` threads through the log line, the API response and the
 * `raw_payloads` row, so an operator can pivot between all three.
 */

import { getConfig } from '@/lib/config';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  try {
    return getConfig().LOG_LEVEL;
  } catch {
    // Logging must never be the thing that crashes a misconfigured deployment.
    return 'info';
  }
}

export interface LogFields {
  request_id?: string;
  event?: string;
  device_imei?: string | null;
  status?: string;
  error_code?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

function emit(level: Level, message: string, fields: LogFields = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;

  const line = JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  });

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};
