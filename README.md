# PAXAFE Integration API

Receives Tive IoT webhook payloads, validates and normalises them into the PAXAFE
canonical **sensor** and **location** formats, and persists them to PostgreSQL.

Built for the Senior Integration Engineer take-home. The companion payload
generator lives in the [Mock Tive Sender](../mock-sender) repository.

---

## Quick start

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and API_KEYS
npm run db:migrate            # apply migrations to your database
npm run dev                   # http://localhost:3000
```

Send a payload:

```bash
curl -i -X POST http://localhost:3000/api/webhook/tive \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "DeviceId": "863257063350583",
    "DeviceName": "A571992",
    "EntryTimeEpoch": 1739215646000,
    "Temperature": { "Celsius": 10.078125 },
    "Location": { "Latitude": 40.810562, "Longitude": -73.879285 }
  }'
```

```json
{
  "status": "processed",
  "request_id": "0f0e...",
  "device_id": "A571992",
  "device_imei": "863257063350583",
  "timestamp": 1739215646000,
  "sensor_id": "...",
  "location_id": "...",
  "data_quality_flags": []
}
```

> `EntryTimeEpoch` above is a February 2025 timestamp and will be rejected by the
> default 90-day ingestion window. Use a recent timestamp, or raise
> `TELEMETRY_MAX_AGE_DAYS`. This is deliberate — see
> [Ingestion window](#ingestion-window-is-policy-not-schema).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Local development server |
| `npm run verify` | Typecheck, lint and test — what CI runs |
| `npm test` | Unit and integration tests |
| `npm run test:watch` | Tests in watch mode |
| `npm run test:coverage` | Coverage report with enforced thresholds |
| `npm run db:generate` | Generate a migration from the schema |
| `npm run db:migrate` | Apply migrations |
| `npm run db:studio` | Browse the database |

Run a single test file or case:

```bash
npx vitest run tests/transform.test.ts
npx vitest run -t "rounds negative accelerometer axes away from zero"
```

---

## Architecture

One Tive payload becomes **two** canonical records that share an identity block,
so a temperature reading and the position it was taken at stay joinable.

```
POST /api/webhook/tive
   |
   |  route handler ......... HTTP only: auth, body limits, status codes
   v
   ingest/pipeline .......... orchestration and error taxonomy
   |
   |-> providers/tive/schema ..... Zod validation of the provider's shape
   |-> ingest/timestamp .......... ingestion window (policy, not schema)
   |-> providers/tive/transform .. Tive -> PAXAFE, pure, no I/O
   |-> px/policy ................. rounding, accuracy category, address parsing
   v
   db/repository ............ the only module that knows SQL
```

The layering exists for one reason: **Tive is provider #1 of eight** in the
PAXAFE `provider` enum. Everything provider-specific is confined to
`src/lib/providers/tive/`. Onboarding TagnTrac means adding a sibling directory
with its own schema and transform — the pipeline, persistence, error handling
and HTTP layer are untouched.

`src/lib/px/` holds the canonical target format and the interpretation policy
that the provided schemas leave open. It has no knowledge of any provider.

### Request flow

1. **Store the raw payload first**, before validation. Nothing is discarded, so
   a validation bug, a transform bug or schema drift on Tive's side leaves a
   replayable row instead of lost telemetry.
2. Validate against the Tive schema.
3. Check the ingestion window.
4. Transform to the canonical formats.
5. Persist both records plus device/shipment context **in one transaction**.
6. Finalise the raw payload's status (`processed` / `duplicate` / `rejected` / `failed`).

Rejections are *recorded*, not merely returned: `raw_payloads.status` and
`error_code` make "what is this sender getting wrong?" a SQL query rather than a
log search.

---

## The transformation

The mapping is not stated in any single provided file; it is the result of
reading the three schemas against each other.

### Identity — shared by both outputs

| PAXAFE | Tive | Note |
|---|---|---|
| `device_id` | `DeviceName` | Stated in `px-sensor-schema.json` |
| `device_imei` | `DeviceId` | The 15-digit IMEI |
| `timestamp` | `EntryTimeEpoch` | Epoch ms, authoritative |
| `provider` | — | Constant `"Tive"` |
| `type` | — | Constant `"Active"` (real-time tracker) |

`DeviceId` and `DeviceName` read like synonyms and map to **opposite** PAXAFE
fields. Inverting them is the easiest way to silently corrupt this integration,
which is why it has a dedicated test.

### Sensor

| PAXAFE | Tive | Precision |
|---|---|---|
| `temperature` | `Temperature.Celsius` | 2 dp |
| `humidity` | `Humidity.Percentage` | 1 dp |
| `light_level` | `Light.Lux` | 1 dp |
| `accelerometer.{x,y,z}` | `Accelerometer.{X,Y,Z}` | 3 dp |
| `accelerometer.magnitude` | `Accelerometer.G` | 3 dp |
| `tilt`, `box_open` | — | Always `null`; Tive reports neither |

### Location

| PAXAFE | Tive | Note |
|---|---|---|
| `latitude` / `longitude` | `Location.Latitude` / `.Longitude` | |
| `location_accuracy` | `Location.Accuracy.Meters` | Narrowed to integer |
| `location_accuracy_category` | *derived* | See below |
| `location_source` | `Location.LocationMethod` | `gps`→`GPS`, `wifi`→`WiFi`, `cell`→`Cellular` |
| `address.full_address` | `Location.FormattedAddress` | Components parsed best-effort |
| `battery_level` | `Battery.Percentage` | |
| `cellular_dbm` | `Cellular.Dbm` | 2 dp |
| `wifi_access_points` | `Location.WifiAccessPointUsedCount` | |
| `altitude`, `cellular_network_type`, `cellular_operator` | — | Always `null` |

Both PAXAFE examples are reproduced **exactly** by the test suite, and every
transformed record is validated against the published JSON Schemas with ajv.

---

## Decisions and assumptions

Full reasoning in [docs/DECISIONS.md](docs/DECISIONS.md). The ones that change
observable behaviour:

### Rounding is half-away-from-zero

The PAXAFE schemas specify decimal precision per field, and Tive sends full
float precision, so rounding is part of the output contract.

`Math.round` breaks ties toward positive infinity: it turns an accelerometer
reading of `-0.5625` into `-0.562`, while `px-sensor-schema.json`'s own example
requires `-0.563`. Negative axes are normal, so this is not academic. The
epsilon correction is *relative* to magnitude — `Number.EPSILON` is defined
against 1.0 and vanishes at the scale rounding actually happens.

### `location_accuracy_category` is derived

The field exists in the PAXAFE schema with **no corresponding Tive field**. The
only fixed point is the example: 23 m → `High`. Thresholds are chosen to match
that anchor and to separate the three location technologies Tive reports:

| Accuracy | Category | Typical source |
|---|---|---|
| ≤ 50 m | `High` | GPS/GNSS (~5 m), WiFi (~20–50 m) |
| ≤ 500 m | `Medium` | Cell tower triangulation |
| > 500 m | `Low` | Coarse cell |

### `address.street` is never inferred

Tive supplies one flat `FormattedAddress` string; PAXAFE wants components. The
parse is best-effort and fails soft — `full_address` is always preserved
verbatim and unidentifiable components stay `null` rather than guessed.

`street` is deliberately never populated. Tive's address is geocoder output
(`GeolocationSourceName: "skyhook"`), whose leading segment is frequently a
venue name rather than a street line — `"114 Hunts Point Market"` in the shipped
sample. `px-location-schema.json`'s own example leaves `street` null for exactly
that address while populating every other component. Writing a venue name into
a field consumers read as a street would contradict the target contract.

### Ingestion window is policy, not schema

Neither timestamp fixture violates the Tive schema — its only constraint is
`minimum: 0`. Rejecting a 2030 or a 2021 reading is therefore a *policy*
decision, made in a separate, configurable, independently tested layer:

- **Future** (default > 60 min ahead): a single reading dated 2030 pins a
  shipment's "latest known state" for years.
- **Stale** (default > 90 days old): usually a device flushing a buffer after
  reconnecting. Real data, but interleaving it into a live timeline
  misrepresents current conditions.

Both bounds are environment-configurable, and rejected payloads are still
persisted to `raw_payloads`, so widening the window and re-driving loses nothing.

> The shipped sample payloads are dated February 2025 and fall outside the
> default window. Tests inject a fixed clock rather than relaxing the policy;
> the Mock Sender generates current timestamps.

### The `Ship33CABOL` fixture

`Missing Device Identifiers - Scenario B` carries `DeviceName: "Ship33CABOL"`
while `EntityName` holds the real device name. It is rejected for the same
structural reason as Scenario A — no `DeviceId`, and `device_imei` is required
by both PAXAFE formats with no fallback source.

The disagreement between `DeviceName` and `EntityName` is handled as a
**data-quality flag** (`device_name_entity_mismatch`) rather than a mapping
override. `DeviceName` is user-programmable and can legitimately be renamed
mid-shipment; silently substituting `EntityName` on a heuristic would make the
mapping unpredictable. The documented mapping wins, and the disagreement is
recorded on the row so it stays queryable.

### Synchronous responses

Validation, transformation and persistence all happen before responding. At this
volume it is the honest choice: the sender learns whether its payload was
genuinely accepted and gets real backpressure when the database is unhealthy.

Storing the raw payload first is the seam where this becomes asynchronous —
everything after step 1 can move to a worker without changing the sender's
contract. That trade is worth making at sustained throughput, not before.

### Idempotency

Webhook senders retry on timeout, and a device cannot have two different
readings for the same instant. A unique index on `(device_imei, recorded_at)`
enforces this; inserts use `ON CONFLICT DO NOTHING`. A replay returns **200 with
`"status": "duplicate"`** instead of 201, so a retrying sender can tell the
difference.

---

## Database

Five tables. `raw_payloads` is the durability and replay layer; the two reading
tables hold exactly the canonical PAXAFE fields; `devices` and `shipments` carry
slowly-changing context that the normalised formats drop but operators need.

```
raw_payloads ──┬── sensor_readings     (device_imei, recorded_at) UNIQUE
               └── location_readings   (device_imei, recorded_at) UNIQUE

devices    (device_imei PK)
shipments  (shipment_id PK)
```

| Choice | Reason |
|---|---|
| `numeric` for sensor values | Readings are compared against regulatory excursion thresholds; float drift is not acceptable. `mode: 'number'` avoids string round-trips. |
| `double precision` for lat/lon | Conventional for coordinates, and what PostGIS expects if geospatial queries are added. |
| `timestamptz`, not epoch ms | PAXAFE emits epoch ms; converted at the boundary so the database stays queryable with ordinary date predicates. |
| `jsonb` for address/tilt/endpoints | Structured but never filtered on. |
| Unique on `(device_imei, recorded_at)` | Idempotency key for webhook retries. |
| Descending recency indexes | "Latest readings for this device/shipment" is the dominant read pattern. |
| `raw_payloads` written first | Dead-letter and replay without a queue. |

Migrations are generated and committed, never pushed straight to a database, so
the deployed schema is reproducible from the repository. They run explicitly
(`npm run db:migrate`) rather than on boot — dozens of concurrent serverless
instances racing to migrate is a reliable way to corrupt a schema.

---

## Testing

```bash
npm test              # 85 tests
npm run test:coverage # thresholds enforced
```

| Suite | What it protects |
|---|---|
| `transform.test.ts` | Both PAXAFE examples reproduced exactly; identity mapping; rounding; flags |
| `conformance.test.ts` | Every output validated against the published JSON Schemas with ajv |
| `validation.test.ts` | All six `invalid_payloads` fixtures, each with its rejection reason |
| `pipeline.test.ts` | Ordering, status transitions, idempotency, error paths |
| `policy.test.ts` | Rounding edge cases, category boundaries, address parsing |
| `auth.test.ts` | Key comparison and header extraction |
| `problem.test.ts` | Error response contract; no internal detail leakage |
| `config.test.ts` | Environment validation |
| `db.integration.test.ts` | Real unique-index idempotency — **skipped** unless `TEST_DATABASE_URL` is set |

Tests read `schemas/sample-tive-payloads.json` directly rather than restating
payloads as literals, so the shipped fixtures stay the single source of truth.

The conformance suite is the important one: it turns "integration accuracy" from
a claim in this README into an assertion that fails the build.

---

## Deployment

Vercel, with `DATABASE_URL`, `API_KEYS` and the optional policy variables set as
environment variables.

Use Supabase's **transaction pooler** (port 6543), not the direct connection.
Serverless functions open a connection per instance, and the direct connection
limit is exhausted quickly under load. The client sets `prepare: false` to match
the pooler's transaction mode; without it you get intermittent
`prepared statement already exists` failures that only appear once real traffic
arrives. Connections are capped at `max: 1` per instance and the client is cached
on `globalThis` so warm starts reuse one pool.

Deployment order is **migrate, then deploy**.

### Operations

- `GET /api/health` returns 503 when the database is unreachable, so a monitor
  can alert on status code alone.
- Logs are one JSON object per line with a `request_id` that also appears in the
  API response and the `raw_payloads` row, so an operator can pivot between all
  three.
- Failed and rejected payloads are queryable:

```sql
select error_code, count(*)
from raw_payloads
where status in ('rejected', 'failed') and received_at > now() - interval '1 day'
group by error_code order by 2 desc;
```

---

## Not built, and why

Scoped out deliberately rather than overlooked:

| Omitted | When it becomes worth adding |
|---|---|
| Queue-backed async ingestion | Sustained throughput beyond what a synchronous function handles. The raw-payload-first ordering is the seam. |
| Per-tenant API keys | `AccountId` is stored; keys are currently global. Needed as soon as more than one customer sends data. |
| Rate limiting | A shared secret plus Vercel's platform limits suffice at this scale. |
| Automatic replay of dead-lettered payloads | Rows are replayable today; a scheduled re-driver is the next step. |
| PostGIS / geofencing | No geospatial queries yet; `double precision` coordinates keep the door open. |
| Distributed tracing | Structured logs with a correlation id cover the current failure modes. |
