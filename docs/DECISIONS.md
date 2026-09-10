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

## 10. Provider enums are accepted leniently

**Decision.** Tive's enum-typed strings (`LocationMethod`, `SignalStrength`,
`Estimation`) are validated as free strings, normalised where recognised, and
flagged where not (`unknown_location_method`).

**Why.** Rejecting an entire shipment's telemetry because Tive shipped a new
location method is the wrong failure mode. Coordinate ranges and the IMEI
pattern *are* enforced strictly, because a violation there means the data is
wrong rather than merely unfamiliar.

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
