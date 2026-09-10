/**
 * The error response shape is part of the public API contract -- a sender
 * branches on it -- so it is tested like one.
 */

import { describe, expect, it } from 'vitest';

import { IngestError } from '@/lib/ingest/errors';
import { jsonResponse, problemResponse, unexpectedError } from '@/lib/http/problem';

async function bodyOf(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe('problemResponse', () => {
  it('emits RFC 9457 problem+json with a stable machine-readable code', async () => {
    const response = problemResponse(
      IngestError.schemaValidation([{ path: 'Location.Latitude', message: 'out of range' }]),
      'req-1',
    );

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('x-request-id')).toBe('req-1');

    expect(await bodyOf(response)).toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
      status: 422,
      request_id: 'req-1',
      retryable: false,
      errors: [{ path: 'Location.Latitude', message: 'out of range' }],
    });
  });

  it('tells the client how to authenticate on a 401', async () => {
    const response = problemResponse(IngestError.unauthorized(), 'req-2');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('omits the errors array when there are no field-level issues', async () => {
    const body = await bodyOf(problemResponse(IngestError.unauthorized(), 'req-3'));
    expect(body).not.toHaveProperty('errors');
  });

  it('marks 4xx as non-retryable and 5xx as retryable', async () => {
    const client = await bodyOf(problemResponse(IngestError.invalidJson(), 'r'));
    const server = await bodyOf(unexpectedError(new Error('boom'), 'r'));
    expect(client.retryable).toBe(false);
    expect(server.retryable).toBe(true);
  });

  it('does not leak internal error text to the caller', async () => {
    const body = await bodyOf(unexpectedError(new Error('password=hunter2 in connection string'), 'r'));
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(body.status).toBe(500);
  });
});

describe('jsonResponse', () => {
  it('echoes the request id so callers can correlate with our logs', () => {
    const response = jsonResponse({ ok: true }, 201, 'req-9');
    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('req-9');
  });
});
