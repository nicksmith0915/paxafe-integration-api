# Error reference

Every error response is [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
`application/problem+json`:

```json
{
  "type": "https://github.com/nicksmith0915/paxafe-integration-api/blob/main/docs/ERRORS.md#schema_validation_failed",
  "title": "schema validation failed",
  "status": 422,
  "code": "SCHEMA_VALIDATION_FAILED",
  "detail": "Payload does not satisfy the Tive telemetry schema.",
  "request_id": "3f9c1f0e-...",
  "retryable": false,
  "errors": [
    { "path": "Location.Latitude", "message": "Latitude must be between -90 and 90." }
  ]
}
```

`code` is stable and safe to branch on. `retryable` states whether resending the
**same** payload could ever succeed. `errors[].path` is a dotted path into the
payload *you sent*, not our internal field names. `request_id` appears in the
response header, our logs and the stored `raw_payloads` row.

| Code | Status | Retryable | Meaning |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | no | Missing or invalid API key. Send `X-API-Key` or `Authorization: Bearer`. |
| `INVALID_JSON` | 400 | no | Body is not parseable JSON. |
| `PAYLOAD_TOO_LARGE` | 413 | no | Body exceeds 256 KB. |
| `SCHEMA_VALIDATION_FAILED` | 422 | no | Payload does not match the Tive schema, or is not a single JSON object. See `errors[]`. |
| `TIMESTAMP_OUT_OF_RANGE` | 422 | no | `EntryTimeEpoch` is outside the ingestion window. If it looks like epoch **seconds**, the message says so. |
| `CONFLICTING_DUPLICATE` | 409 | no | A reading with *different* measurements is already stored for this device and timestamp. The stored reading is kept; this payload is retained for review. |
| `PAYLOAD_NOT_STORABLE` | 422 | no | The database rejected a value in the payload itself (Postgres SQLSTATE class 22 or 23). Resending it unchanged will fail identically. |
| `PERSISTENCE_FAILED` | 503 | **yes** | Payload was valid; the database was unavailable (connection, deadlock, resource or operator errors). Retry with backoff. |
| `INTERNAL_ERROR` | 500 | **yes** | Unexpected failure. Retry with backoff; quote `request_id` when reporting. |

## Success responses

| Status | Meaning |
|---|---|
| 201 | Reading created. |
| 200 | Already stored — `"status": "duplicate"`. The idempotency key `(device_imei, timestamp)` already existed **with identical measurements**. Not an error; stop retrying. |

Both carry `data_quality_flags`. A flag never causes a rejection: it records
something noteworthy about an accepted reading, such as a physically impossible
sensor value that was stored as `null`, a battery percentage that was rounded,
or coordinates of exactly `(0, 0)`. The full list is `DataQualityFlag` in
`src/lib/px/types.ts`.

## Notes for senders

- **Do not retry any 4xx unchanged.** It will fail identically.
- **Do retry 5xx** with exponential backoff. The payload is already persisted in
  `raw_payloads`, so a retry is safe and idempotent.
- A duplicate response means your previous attempt succeeded even if you never
  saw the response.
- `SCHEMA_VALIDATION_FAILED` reports *every* problem at once, not just the first.
- A `409 CONFLICTING_DUPLICATE` means two payloads claimed different readings for
  the same device at the same instant. Retrying will not change that; it needs a
  human, and the rejected payload is kept in `raw_payloads` with status
  `conflict` for exactly that.
- Retryability follows the cause, not the status family alone: an error from the
  database is retryable only when the database was unavailable, never when it
  rejected the data.
