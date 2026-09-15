# Decisions and assumptions

The exercise says to make reasonable assumptions and document them. This is that
document: what the provided schemas left open, what was chosen, and why.

Decisions that change observable API behaviour are summarised in the README;
this file records the full reasoning, including the ones that were close calls.

---

## 1. `device_id` comes from `DeviceName`, `device_imei` from `DeviceId`

**Ambiguity.** Tive sends `DeviceId`, `DeviceName` and `EntityName`. PAXAFE wants
`device_id` and `device_imei`. The names invite the wrong pairing.

**Decision.** `px-sensor-schema.json` states it outright — `device_id` is
"Device identifier (from DeviceName)" — and `DeviceId` carries the documented
15-digit IMEI pattern, matching `device_imei`. So the mapping crosses over.

**Consequence.** Inverting these would corrupt every record while still
producing schema-valid output, so it has a dedicated regression test.

---

## 2. `location_accuracy_category` thresholds

**Ambiguity.** The field is in the PAXAFE location schema with **no source field
in the Tive payload**. It must be derived, and no thresholds are given.

**Decision.** Derived from accuracy in metres: <= 50 m `High`, <= 500 m `Medium`,
above that `Low`, inclusive at each boundary.

**Why these numbers.** The only fixed point available is the PAXAFE example,
which pairs 23 m with `High`. The boundaries then separate the three location
technologies Tive actually reports — GNSS at ~5 m and WiFi at ~20-50 m are both
`High`; cell-tower triangulation at ~500 m is `Medium`; anything coarser is
`Low`. The shipped samples exercise all three.

**Alternative rejected.** Deriving the category from `LocationMethod` instead
would ignore the accuracy radius Tive actually measured, and would misclassify a
GPS fix taken with poor sky visibility.

---

## 3. Rounding is half-away-from-zero, with a relative epsilon

**Ambiguity.** The PAXAFE schemas specify precision per field ("2 decimal
points"). Tive sends full float precision. Nothing states a tie-breaking rule.

**Decision.** Round half away from zero, nudging by a magnitude-relative epsilon.

**Why.** `Math.round` breaks ties toward positive infinity, so `-0.5625` becomes
`-0.562` — but `px-sensor-schema.json`'s own example requires `-0.563` for that
exact input. Two of the three accelerometer axes in the sample are negative, so
the wrong rule is immediately visible in real output.

The epsilon has to be relative: decimal literals are not exactly representable,
so `1.005 * 100` evaluates to `100.49999999999999`. `Number.EPSILON` is defined
against 1.0 and is far too small to correct that at magnitude 100; scaling by
`(1 + Number.EPSILON)` corrects it at any magnitude while being too small to
move a value that is not already at the boundary.

---

## 4. `address.street` is never inferred

**Ambiguity.** Tive sends one flat `FormattedAddress`. PAXAFE wants street,
locality, state, country and postal code.

**Decision.** Parse locality, state, postal code and country best-effort; never
populate `street`; always preserve the original text in `full_address`.

**Why.** Tive's address is geocoder output — the sample carries
`GeolocationSourceName: "skyhook"` — whose leading segment is frequently a venue
or POI name rather than a street line. The shipped sample is exactly this:
`"114 Hunts Point Market, Bronx, NY 10474, USA"`. PAXAFE's own example parses
that address and leaves `street` null while populating every other component.

This was a close call — the parser can extract that segment, and an earlier
iteration did. It was removed because matching the target contract matters more
than extracting one extra field, and because writing a venue name into a field
consumers treat as a street is worse than leaving it null. Nothing is lost:
`full_address` retains the complete string.

**Assumption.** Address parsing is US-centric (`ST 12345` / `ST 12345-6789`).
Non-US addresses degrade to locality and country. A production system would use
a real geocoding library rather than string splitting.

---

## 5. The ingestion window is policy, not schema

**Ambiguity.** Two fixtures are labelled invalid on timestamp grounds, yet
neither violates the Tive schema, whose only constraint is `minimum: 0`.

**Decision.** Reject outside a configurable window — default more than 60
minutes in the future, or more than 90 days old — in a distinct layer with a
distinct error code (`TIMESTAMP_OUT_OF_RANGE`), separate from schema validation.

**Why reject at all.**
- A future timestamp pins a shipment's "latest known state" for years. One
  reading dated 2030 poisons every "current conditions" query.
- A very old timestamp usually means a device flushed a buffer after
  reconnecting. The data is real, but interleaving it into a live shipment
  timeline misrepresents present conditions.

**Why configurable.** The right window is a business question — a backfill needs
a wide one, live monitoring a narrow one — and neither answer belongs hard-coded
in a validator.

**Consequence and assumption.** The shipped sample payloads are dated February
2025 and fall outside the default window relative to any present-day clock.
Tests inject a fixed clock rather than weakening the policy; the Mock Sender
generates current timestamps. Rejected payloads are still stored in
`raw_payloads`, so widening the window and re-driving them loses nothing.

---

## 6. `Ship33CABOL`: flag the disagreement, keep the mapping

**Ambiguity.** `Missing Device Identifiers - Scenario B` sets
`DeviceName: "Ship33CABOL"` — a shipment-style name — while `EntityName` holds
what looks like the real device name.

**Decision.** Reject the payload (it has no `DeviceId`, and `device_imei` has no
fallback source), and where such a payload is otherwise valid, keep
`device_id = DeviceName` while recording a `device_name_entity_mismatch` flag on
the row.

**Why not substitute `EntityName`.** `DeviceName` is user-programmable and can
be legitimately renamed mid-shipment. A heuristic that silently switches source
fields when a name "looks like" a shipment id would make the mapping
unpredictable and untestable — and would be wrong for any customer whose naming
convention happens to resemble the pattern. The documented mapping wins; the
anomaly is made queryable instead of being resolved by guesswork.

---

## 7. Synchronous ingestion

**Ambiguity.** The exercise explicitly leaves sync vs async open.

**Decision.** Validate, transform and persist before responding. 201 on create,
200 on duplicate, 5xx when the database is unavailable.

**Why.** At this volume the sender learns whether its payload was genuinely
accepted, and gets real backpressure when the database is unhealthy. An
immediate 202 would be a more scalable lie: it reports success for payloads that
may never be stored.

**The seam.** The raw payload is persisted before anything can reject it, so
everything after that step can move behind a queue without changing the
sender's contract. That trade is worth making at sustained throughput, not
before — and a queue on Vercel's free tier would be theatre.

---

## 8. Store the raw payload before validating

**Decision.** Every request body is written to `raw_payloads` first,
unconditionally, and its status finalised at the end.

**Why.** It converts three separate problems into one solved problem: a
dead-letter queue for rejects, replay capability for transform bugs, and an
audit trail of what the provider actually sent. Tive's schema will drift; when
it does, the evidence is in the database rather than gone.

**Cost.** One extra insert and one update per request. Acceptable at this volume,
and the table is the obvious first candidate for a retention policy.

---

## 9. Fields with no PAXAFE destination

`Shipment.*`, `AccountId`, `PublicShipmentId`, `Cellular.SignalStrength`,
`Battery.Estimation`/`IsCharging`, `Location.GeolocationSourceName`,
`CellTowerUsedCount`, `Temperature.Fahrenheit` and `ProbeTemperature` are all
dropped by the canonical formats.

**Decision.** Shipment and account context are persisted to dedicated
`shipments` / `devices` tables; the rest survive in the raw payload.
`ProbeTemperature` additionally raises a `probe_temperature_dropped` flag when
present, since discarding a second temperature sensor in a cold-chain system is
worth surfacing rather than doing silently.

**Why.** `AccountId` is the multi-tenancy key and shipment identifiers are how
telemetry is correlated with a business process. Discarding them because the
normalised format has no slot would be a design decision imposed by a schema
rather than by the domain.

---

## 10. Strict on identity and position, lenient on everything else

**Decision.** Only the fields that identify and place a reading are validated
strictly: the IMEI pattern, the timestamp and the coordinate ranges. Everything
else is accepted and corrected or flagged downstream:

- Tive's enum-typed strings (`LocationMethod`, `SignalStrength`, `Estimation`)
  are free strings, normalised where recognised and flagged where not
  (`unknown_location_method`).
- Battery percentage and access-point / tower counts accept any number. A
  fractional battery is rounded (`battery_rounded`); an impossible one is nulled
  (`battery_out_of_range`); a fractional or negative count is nulled
  (`wifi_access_points_invalid`).

**Why.** A violation in identity or position means the reading cannot be
attributed or placed, which nothing downstream can fix. A violation anywhere else
means one secondary value is wrong or unfamiliar. Rejecting the whole payload for
that discards the temperature and position reported alongside it -- in cold chain,
the two measurements that matter most. An earlier version rejected an entire
reading because the battery was `65.5`; that was this principle applied
inconsistently, and is fixed.

---

## 11. Authentication

**Decision.** Static API keys in `X-API-Key` (or bearer), compared in constant
time after SHA-256 hashing, with multiple keys accepted simultaneously.

**Why.** It matches how Tive-style webhook senders actually authenticate. Hashing
first gives `timingSafeEqual` the equal-length buffers it requires and stops the
comparison leaking key length; every candidate is checked with no early exit, so
timing does not reveal which key matched.

**Assumption.** Keys are global, not per-tenant. `AccountId` is stored, so
scoping keys to accounts is a schema addition rather than a redesign — but it is
genuinely not built, and would be required before a second customer sends data.

---

## 12. HMAC signature verification is not implemented

Tive's production webhooks may support request signing. Nothing in the provided
schemas describes a signature header, so implementing one would mean inventing a
scheme that could not interoperate. An API key is the documented mechanism here.
In a real onboarding this is the first question to ask the provider.

---

## 13. Trade-off: an unavailable database rejects everything

Because the raw payload is stored before validation (decision 8), a database
outage produces `503 PERSISTENCE_FAILED` for *every* request — including
payloads that are malformed and could never succeed.

**Why this is accepted.** The alternative is validating first so that malformed
payloads still receive a 422 while the database is down. That optimises the
response given to a broken sender during an outage, at the cost of the property
that matters more: if our own validator is wrong about a payload Tive considers
valid — the likeliest failure in any provider integration, since their schema
will drift — the data is gone rather than replayable.

**Consequence.** `retryable: true` on that 503 is correct for valid payloads and
misleading for invalid ones: a sender retrying a malformed payload will get a
422 once the database recovers. That is a bounded cost during an outage, and the
sender learns the truth as soon as the system is healthy again.

---

## 14. Retryability is derived from the database error class

**Problem found.** Four payloads -- a JSON `null` body, a NUL byte in any string,
humidity `1000`, temperature `99999` -- passed validation and then failed in
Postgres. Every database failure was reported as `503 PERSISTENCE_FAILED`,
`retryable: true`. Tive retries 5xx, so each would have been retried forever by a
sender told, incorrectly, that trying again might work.

**Decision.** Classify by SQLSTATE. Class `22` (data exception) and `23`
(integrity constraint violation) describe the data and become
`422 PAYLOAD_NOT_STORABLE`, non-retryable, with the raw payload marked
`rejected`. Everything else -- no SQLSTATE at all (network, DNS, TLS), connection,
serialization, deadlock, resource and operator errors -- stays a retryable 503
and the payload is marked `failed`, meaning worth re-driving.

**Why unknown classes default to retryable.** For telemetry the two mistakes are
not symmetric. A retry storm caused by our own bug stops being a problem once the
bug is fixed, and nothing is lost. Telling a sender to discard a valid reading
loses it permanently.

**Why this as well as the specific fixes below.** The specific fixes remove the
four known causes. The classification is what stops the *next* unforeseen one
from becoming an infinite retry loop. It is tested against real postgres.js
errors in `db.integration.test.ts`, not only against a hand-built imitation.

---

## 15. Physically impossible sensor values are nulled and flagged

**Decision.** Each canonical value has a plausibility range (`PLAUSIBLE_RANGES`
in `src/lib/px/policy.ts`). A value outside it is stored as `null` with a
per-field flag such as `humidity_out_of_range`.

**Why not reject.** A glitching humidity sensor must not cost the temperature and
position reported in the same payload.

**Why not clamp.** Clamping humidity `1000` to `100` stores a reading that was
never taken. In a regulated cold chain, invented data is worse than missing data.

**How the bounds were chosen.** From physics or hardware, never from what a
normal shipment looks like, so a real excursion is never discarded. Temperature
runs from absolute zero to 150 C: cryogenic cell-therapy shippers operate at
-196 C, so a "pharma cold chain" bound of, say, -80 C would have silently deleted
legitimate readings.

**Why a test ties them to the schema.** Every bound sits inside its column's
precision, and `tests/bounds.test.ts` asserts it against the Drizzle schema. That
makes "no value that passes the bounds can overflow on insert" a checked property
rather than a comment.

---

## 16. A conflicting duplicate is a 409, not a duplicate

**Problem found.** Two payloads with the same device and timestamp but different
temperatures (5 C, then 30 C) returned `201` then `200 duplicate`. The second
reading was silently discarded and reported as a harmless retry.

**Decision.** When an insert hits the idempotency key, compare the measured
values against the stored reading. Identical: `200 duplicate`, as before.
Different: roll back the whole transaction (so the device and shipment upserts do
not apply either), return `409 CONFLICTING_DUPLICATE`, and mark the raw payload
`conflict` for review.

**Why it matters here specifically.** In cold chain, a contradiction at the same
instant is exactly what a real temperature excursion looks like against a stale
buffered reading. Calling it a duplicate hides the one event the system exists to
surface.

**What is compared.** Measurements only. The device name is excluded because it
is user-programmable and can legitimately change mid-shipment; the address is
excluded because geocoder output varies for identical coordinates. The first
reading wins: which of two contradictory readings is correct is a question for a
human, not for insertion order.

---

## 17. Bodies Postgres cannot store are still recorded

**Decision.** NUL bytes (U+0000) are replaced with U+FFFD before the raw payload
is written, and flagged `nul_bytes_replaced`. A JSON `null` body is written as the
JSON literal `null` rather than SQL NULL. A body that is not a single object is
recorded and then rejected with a message naming the actual problem -- including
that batches are not supported.

**Why.** Postgres refuses U+0000 in both `text` and `jsonb`, and the raw payload
column is NOT NULL. Either made the audit insert fail, so the request left no
trace -- the one outcome the raw-payload-first design (decision 8) exists to
prevent.

**Why U+FFFD rather than removal.** Removal would turn a corrupted device name
into a plausible-looking valid one. The replacement character keeps the damage
visible. It does mean the stored raw body is no longer byte-identical to what was
sent; that is the smallest possible deviation, and the flag records that it
happened.

---

## 18. Coordinates of exactly (0, 0) are flagged, not rejected

**Decision.** Latitude and longitude of exactly zero are stored as reported and
flagged `null_island_coordinates`.

**Why.** It is a valid coordinate -- in the Gulf of Guinea -- and also the
best-known failure signature of a tracker with no position fix. PAXAFE requires
coordinates, so nulling them is not an option, and substituting a last-known
position would be a guess. Flagging lets mapping and geofencing exclude them. A
coordinate merely on the equator or the prime meridian is not flagged.

---

## 19. Epoch seconds are recognised, but not converted

**Decision.** An `EntryTimeEpoch` below `1e11` -- March 1973 in milliseconds, and
below which every current epoch-*seconds* value falls -- is still rejected as
`TIMESTAMP_OUT_OF_RANGE`, but the message states that it looks like seconds and
shows what it would be in milliseconds.

**Why not convert it.** Guessing the unit would make a genuinely corrupt timestamp
look valid. Sending seconds where milliseconds are expected is the classic unit
bug in webhook integrations; the sender should be told plainly and fix it at the
source, rather than be told their reading is 56 years old.

---

## 20. Functions run in the database's region

**Decision.** Pin Vercel functions to `pdx1`, beside the Supabase database in
`us-west-2`, via `vercel.json`.

**Why.** Measured, not assumed: from the default `iad1` region every database
round-trip cost about 70 ms, and an ingest makes several (raw insert, the
readings transaction, the status update), so one payload took 1.6–2.9 s end to
end. For a synchronous webhook (decision 7), that latency is paid by every
sender on every reading. The region is set in project configuration because
Next.js 16 deprecates the `preferredRegion` segment option.

---

## 21. Public endpoints report state, not causes

**Decision.** `/api/health` returns whether the database is reachable and never
the error; RFC 9457 error bodies never carry internal detail. Both log the full
cause server-side.

**Why.** The health check must be unauthenticated to be useful to a monitor,
which makes it readable by anyone. A driver error such as `connect ECONNREFUSED`
or an authentication failure names hosts, ports and poolers -- valuable to an
operator, and equally to someone mapping the infrastructure.

---

## 22. Bodies too deep to process are rejected before they are walked

**Decision.** A body nested more than 32 levels deep is rejected with a 422, and
a stub is recorded in place of the body so the request is still audited.
Timestamps are capped at the largest instant a JavaScript Date can represent.

**Why.** Both previously crashed the handler with a retryable 500. `JSON.parse`
accepts arbitrary depth, but everything afterwards -- sanitisation, validation,
and the database driver's own `JSON.stringify` -- recurses and overflows the
stack. A 200 KB body of brackets, inside the size limit, was enough. The depth
check is iterative, because a recursive one would crash on exactly the input it
guards against. A real Tive payload is three levels deep.

---

## 23. Integration tests refuse the application's database

**Decision.** The persistence suite compares `TEST_DATABASE_URL` against every
`DATABASE_URL` the application is configured with, and refuses to run on a
match. Local databases are always allowed.

**Why.** The suite truncates every table. During development it was run against
the production connection string and did exactly that. A guard that depends on
remembering not to do something is not a guard. Databases are compared by user,
host, port and name, so an added `?sslmode=` or a different password cannot slip
past; local databases are exempt because CI deliberately migrates and tests the
same container.
