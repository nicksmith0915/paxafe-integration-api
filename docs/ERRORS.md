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
| `SCHEMA_VALIDATION_FAILED` | 422 | no | Payload does not match the Tive schema. See `errors[]`. |
| `TIMESTAMP_OUT_OF_RANGE` | 422 | no | `EntryTimeEpoch` is outside the ingestion window. |
| `PERSISTENCE_FAILED` | 503 | **yes** | Payload was valid; the database was unavailable. Retry with backoff. |
| `INTERNAL_ERROR` | 500 | **yes** | Unexpected failure. Retry with backoff; quote `request_id` when reporting. |

## Success responses

| Status | Meaning |
|---|---|
| 201 | Reading created. |
| 200 | Already stored — `"status": "duplicate"`. The idempotency key `(device_imei, timestamp)` already existed. Not an error; stop retrying. |

## Notes for senders

- **Do not retry any 4xx unchanged.** It will fail identically.
- **Do retry 5xx** with exponential backoff. The payload is already persisted in
  `raw_payloads`, so a retry is safe and idempotent.
- A duplicate response means your previous attempt succeeded even if you never
  saw the response.
- `SCHEMA_VALIDATION_FAILED` reports *every* problem at once, not just the first.
