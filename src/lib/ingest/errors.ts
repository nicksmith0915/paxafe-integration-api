/**
 * Error taxonomy for the ingestion pipeline.
 *
 * Codes are stable, machine-readable strings. A sender should be able to branch
 * on `code` alone and decide whether a retry could ever succeed -- which is what
 * `retryable` encodes. Tive-style webhook senders retry on 5xx; every 4xx here
 * is permanent for that payload and must not be retried unchanged.
 */

export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_JSON: 'INVALID_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
  TIMESTAMP_OUT_OF_RANGE: 'TIMESTAMP_OUT_OF_RANGE',
  TRANSFORM_FAILED: 'TRANSFORM_FAILED',
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface FieldIssue {
  /** Dotted path into the *incoming* payload, e.g. "Location.Latitude". */
  path: string;
  message: string;
}

export class IngestError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly issues: FieldIssue[];
  /** Whether the same payload could succeed if sent again unchanged. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    options: { issues?: FieldIssue[]; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'IngestError';
    this.code = code;
    this.status = status;
    this.issues = options.issues ?? [];
    this.retryable = options.retryable ?? status >= 500;
  }

  static unauthorized(message = 'Missing or invalid API key.'): IngestError {
    return new IngestError(ERROR_CODES.UNAUTHORIZED, 401, message);
  }

  static invalidJson(cause?: unknown): IngestError {
    return new IngestError(ERROR_CODES.INVALID_JSON, 400, 'Request body is not valid JSON.', {
      cause,
    });
  }

  static payloadTooLarge(limitBytes: number): IngestError {
    return new IngestError(
      ERROR_CODES.PAYLOAD_TOO_LARGE,
      413,
      `Request body exceeds the ${limitBytes} byte limit.`,
    );
  }

  static schemaValidation(issues: FieldIssue[]): IngestError {
    return new IngestError(
      ERROR_CODES.SCHEMA_VALIDATION_FAILED,
      422,
      'Payload does not satisfy the Tive telemetry schema.',
      { issues },
    );
  }

  static timestampOutOfRange(issues: FieldIssue[]): IngestError {
    return new IngestError(
      ERROR_CODES.TIMESTAMP_OUT_OF_RANGE,
      422,
      'Payload timestamp falls outside the accepted ingestion window.',
      { issues },
    );
  }
}
