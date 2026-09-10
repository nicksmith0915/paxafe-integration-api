/**
 * Error responses, shaped as RFC 9457 "Problem Details".
 *
 * Using the standard rather than an ad-hoc `{error: "..."}` envelope means the
 * response is self-describing: `type` links to documentation, `code` is stable
 * for machine branching, and `errors[]` pinpoints the offending fields using
 * paths into the payload the *sender* posted -- not our internal field names,
 * which would be useless to whoever has to fix the sender.
 */

import { IngestError, type ErrorCode, type FieldIssue } from '@/lib/ingest/errors';

const DOC_BASE = 'https://github.com/paxafe/integration-api/blob/main/docs/ERRORS.md';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  request_id: string;
  retryable: boolean;
  errors?: FieldIssue[];
}

export function problemResponse(error: IngestError, requestId: string): Response {
  const body: ProblemBody = {
    type: `${DOC_BASE}#${error.code.toLowerCase()}`,
    title: error.code.replace(/_/g, ' ').toLowerCase(),
    status: error.status,
    code: error.code,
    detail: error.message,
    request_id: requestId,
    retryable: error.retryable,
    ...(error.issues.length > 0 ? { errors: error.issues } : {}),
  };

  const headers: Record<string, string> = {
    'content-type': 'application/problem+json',
    'x-request-id': requestId,
  };

  // Tell an authenticating client how to authenticate, per RFC 9110.
  if (error.status === 401) headers['www-authenticate'] = 'Bearer realm="paxafe-integration"';

  return new Response(JSON.stringify(body), { status: error.status, headers });
}

export function jsonResponse(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
  });
}

/** Anything that escapes the pipeline becomes a 500 without leaking internals. */
export function unexpectedError(cause: unknown, requestId: string): Response {
  return problemResponse(
    new IngestError('INTERNAL_ERROR', 500, 'An unexpected error occurred while ingesting the payload.', {
      cause,
      retryable: true,
    }),
    requestId,
  );
}
