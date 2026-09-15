/**
 * Database error classification.
 *
 * Whether a failed write is worth retrying is a property of *why* it failed,
 * and Postgres says why: every error carries a five-character SQLSTATE whose
 * first two characters are its class.
 *
 *   22  data exception        numeric overflow, invalid text encoding, bad JSON
 *   23  integrity constraint  NOT NULL, foreign key, check violations
 *
 * Both describe the data being written. The same payload will fail the same way
 * forever, so reporting either as a retryable 503 turns one bad reading into an
 * endless retry loop from any webhook sender that retries on 5xx -- which is
 * all of them.
 *
 * Everything else stays retryable: no SQLSTATE at all (network failure, DNS,
 * TLS), 08 connection exceptions, 40 serialization failures and deadlocks, 53
 * insufficient resources, 57 operator intervention. Unknown classes default to
 * retryable deliberately. For telemetry, a retry storm caused by our own bug is
 * recoverable once the bug is fixed; telling a sender to discard a valid
 * reading is not.
 */

/** SQLSTATE classes that describe the data rather than the database's state. */
const PERMANENT_CLASSES = new Set(['22', '23']);

/**
 * SQLSTATE is five characters from [0-9A-Z] and, in practice, always contains a
 * digit. Requiring one keeps Node system error codes such as EPIPE -- also five
 * uppercase letters -- from being mistaken for a database error.
 */
const SQLSTATE_PATTERN = /^(?=.*\d)[0-9A-Z]{5}$/;

export interface DbErrorInfo {
  sqlstate: string | null;
  /** Whether the same statement could succeed if attempted again later. */
  retryable: boolean;
  /** Operator-facing description, including the driver cause. */
  message: string;
}

/** Drizzle wraps driver errors, so the SQLSTATE lives somewhere down the cause chain. */
function findSqlstate(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE_PATTERN.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Drizzle's outer message is "Failed query: <sql>" with the bound parameters on
 * the following line; the actionable part ("numeric field overflow", "connect
 * ECONNREFUSED") is in the cause. Only the first line of each is kept, which
 * also keeps payload values out of the logs.
 */
export function describeDbError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const firstLine = (text: string) => text.split(/\r?\n/)[0].trim();
  const base = firstLine(error.message);
  const cause = error.cause;
  const detail = cause instanceof Error ? firstLine(cause.message) : typeof cause === 'string' ? cause : null;
  return detail && detail !== base ? `${base}: ${detail}` : base;
}

export function classifyDbError(error: unknown): DbErrorInfo {
  const sqlstate = findSqlstate(error);
  const retryable = !(sqlstate !== null && PERMANENT_CLASSES.has(sqlstate.slice(0, 2)));
  return { sqlstate, retryable, message: describeDbError(error) };
}
