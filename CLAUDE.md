# CLAUDE.md

Guidance for Claude Code when working in this repository. This project implements one feature — **appointment booking** — for the Ownership domain of the Automotive Retail Platform (ARP), following a completed design phase.

> **Governing rule: implement strictly per the detail design docs. If anything is ambiguous, undecided, or requires a judgment call not already answered in the docs or `Design_Discussion_Log.md`, stop and raise it for explicit confirmation — do not assume, guess, or silently pick a default.** Every other instruction in this file is a specific instance of this rule.

---

## 1. Where the design lives

All design artifacts are the source of truth. **Read the relevant one in full before writing or modifying code that touches it** — do not guess at a business rule, error code, or SQL shape that's already specified there.

| File | What it covers |
|---|---|
| `docs/DesignDocument.md` | Feature overview, assumptions, scope, architecture fit, data flow, technology choices, observability strategy |
| `docs/Architecture.md` | Baseline platform architecture (pre-existing, not part of this feature) |
| `docs/detail_design/DD_API_Gateway_Appointments.md` | Full REST contract for `POST /api/v1/ownership/appointments` — headers, request/response shapes, every status code, REST↔gRPC mapping |
| `docs/detail_design/DD_Scheduler_Service_CreateAppointment.md` | Full gRPC contract and business logic for `SchedulerService.CreateAppointment` — proto, validation rules (numbered, categorized), the exact SQL for availability checking, concurrency strategy |
| `docs/images/DatabaseSchema.png` | ERD — table names and columns are PascalCase; use this as ground truth for the DB schema |
| `docs/Design_Discussion_Log.md` | Point-by-point record of every design decision made, who raised it, and why. **Check this before treating anything as arbitrary or "obviously" fixable** — most non-obvious choices in the two detail design docs were deliberated here. Its closing "Summary of Currently Open / Unresolved Items" lists what's still genuinely undecided. |

If a design doc and this file ever disagree, the design doc wins — flag the discrepancy rather than silently picking one.

---

## 2. Implementation scope — read this before starting

**Only implement the two methods fully specified in the detail design docs:**

1. `POST /api/v1/ownership/appointments` (API Gateway, REST)
2. `SchedulerService.CreateAppointment` (Scheduler Service, gRPC)

Everything else this feature touches is a **stub or fixture**, not a real implementation:

| Dependency | Treatment |
|---|---|
| Identity Provider (JWT issuance) | **Stub.** Verify JWTs against a fixed test signing secret/key documented in `.env.example`. Do not integrate a real IdP. `requested_user_id` just needs to come from a validated token's subject claim. |
| `Vehicle`, `Dealership`, `ServiceBay`, `Technician`, `WorkshopService` tables | **Not stubs — real tables, fixture data.** Per `Architecture.md`, these live as plain tables in the same Postgres database as `WorkshopServiceSchedule` (no separate microservices to call, no mocking needed). Implement the schema per the ERD and seed it with a handful of fixture rows (e.g. 2–3 dealerships, a few bays/technicians per dealership at varying `TechLevel`, a couple of `WorkshopService` rows with different `Duration`/`RequiredTechLevel`) so the two endpoints can be exercised end-to-end. |
| Event Broker / notifications | **Not implemented at all.** Marked "Future consider" in `Architecture.md` — no stub needed, just omit. |
| Slot-availability cache (Redis, for a future read-path "list available slots" endpoint) | **Not implemented.** Marked "Future consider." Don't build a slot-listing endpoint — it doesn't exist in scope. |
| Idempotency-Key cache (Redis) | **Real, in scope.** This is part of the feature itself (gateway DD, Section 2.7), not a dependency to stub. |
| Any other endpoint (auth/login, vehicle list, dealership list, etc.) | **Out of scope.** Don't build UI-support endpoints; only the one write path above. |

If something looks like it should exist for the app to be "complete" (e.g. a way to log in, a way to list a customer's vehicles) but isn't one of the two methods above, that's exactly the governing-rule case above — raise it, don't add it.

**Database bootstrapping is a local-dev convenience, not part of the feature scope** — per `Architecture.md`, the database is assumed to already exist. No ORM, no migration tool, no versioned schema history: just plain `.sql` files that Postgres's official Docker image auto-runs on first container start (`docker-entrypoint-initdb.d/`):

```
docker/init/
  01-schema.sql   -- CREATE TABLE for all 6 tables, CREATE EXTENSION btree_gist, the two EXCLUDE constraints
  02-seed.sql     -- fixture rows described above
```

Mount this folder in `docker-compose.yml`; `docker compose up` on a fresh volume gives a ready-to-use DB. Don't build migration tooling or an ORM schema layer for this — it would be solving a production schema-evolution problem this project doesn't have.

---

## 3. Tech stack

- **Language:** Node.js (LTS).
- **Suggested libraries** (defaults — adjust if you have a project-specific reason to deviate, but note the change):
  - `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express` — API Gateway framework. Provides module/controller/provider structure and dependency injection rather than hand-rolled Express routing, which fits a two-layer split (HTTP concerns vs. gRPC client call) more cleanly as the codebase grows.
  - `@nestjs/microservices` (with the gRPC transport) — for the Scheduler Service's gRPC server, and/or for the gateway's outbound gRPC client, so both sides of the internal call can share Nest's module/DI structure rather than wiring `@grpc/grpc-js` manually.
  - `pg` — Postgres client (raw SQL is preferred here over an ORM; the detail design's SQL, including the `NOT EXISTS` availability queries and `FOR UPDATE SKIP LOCKED`, should be run close to as specified rather than reconstructed through query-builder abstractions that might change its semantics).
  - `ioredis` — Redis client (idempotency cache).
  - `jsonwebtoken` — JWT verification (against the stubbed test secret).
- **Testing:** unit tests for validation-rule logic (Scheduler Service DD, Section 3.2's numbered rules) and the end-time/lunch-break calculation; an integration/concurrency test that fires overlapping concurrent requests at the same dealership to confirm the `EXCLUDE` constraint and locking actually prevent a double-booking — this is the feature's core correctness property and should not ship untested.

---

## 4. Coding Conventions

- **Naming mirrors the design docs' vocabulary.** Use `ServiceBay`, `Technician`, `RequiredTechLevel`, `NO_AVAILABILITY`, etc. exactly as the DDs name them — don't invent synonyms or abbreviations. A reviewer comparing code to the DD should recognize the same terms immediately, not have to mentally translate.
- **Casing bridges, not casing fixes.** DB columns are PascalCase, proto/JSON fields are snake_case (see Section 5's casing bullet) — that split is intentional and documented, not something to "clean up" into one style. Internal TypeScript variables/functions use normal camelCase; the mapping between the three happens at explicit boundary layers (SQL result mapping, DTO/proto (de)serialization), not by forcing one convention everywhere.
- **Function granularity mirrors the DDs' own structure** — one function per validation-rule group (rules 1–3, 4–7, 8–12) and one per numbered step in Scheduler DD 3.3 / Gateway DD 2.7, rather than one large handler. This keeps code reviewable section-by-section against the DD, the same way the DD itself was structured for review.
- **Named constants, not magic numbers/strings.** Business hours, the 15-minute slot/buffer, the 1-month window, the lunch-break duration, and every gRPC/HTTP status code should be defined once and referenced, not repeated as literals.
- **Test files start with a top-level comment listing all test cases**, categorized by success/error and grouped by the function or rule being tested. This makes coverage scannable without opening the test body. Example structure:
  ```
  // validateFormat
  //   Success
  //     - valid request
  //   Error — Rule 1: ID fields missing or malformed
  //     - vehicle_id missing
  //     - vehicle_id malformed
  //   ...
  ```
- **Comments — function headers are short overviews; bodies are segmented.**
  - Every function gets a TSDoc `/** ... */` with a single-line overview of what the function does — no step lists, no rule numbers, no DD section pointers. Steps and details belong in the body, not the header.
  - Add `@throws <STATUS_CODE> <condition>` lines for every gRPC error the function can raise, using DD field names and status code names exactly (e.g. `@throws NOT_FOUND if vehicle_id, dealership_id, or workshop_service_id doesn't exist or IsActive = false`).
  - Within a function body, split logic into blocks by concern, each preceded by a one-line comment describing that block (using DD terminology where applicable), with a blank line separating it from the next block.
  - **Exception — non-obvious "don't simplify this" details still need an explicit warning within the relevant body comment.** E.g. half-open interval comparisons (`<`/`>`, not `<=`/`>=`) and `NOT EXISTS` vs. `NOT IN` — these look like arbitrary choices but aren't, and a future edit could "simplify" them into something subtly wrong without a comment flagging it.
- **Extend within the documented scope — don't speculatively generalize.** Don't build generic abstractions "in case" a feature not in the DDs gets added later (per the governing rule above) — that's premature complexity for a scope that may never materialize. Write clean, well-separated code so extending it *would* be straightforward later, without pre-building the extension itself.

---

## 5. Load-bearing decisions — do not casually change these

These are specified in detail in the design docs, but are easy to get subtly wrong if reconstructed from memory rather than read directly. Treat any deviation as something to flag, not silently "improve":

- **Double-booking prevention has two layers**: application-level `SELECT ... FOR UPDATE SKIP LOCKED` with `NOT EXISTS` (not `NOT IN`) for candidate selection, *and* a Postgres `EXCLUDE` constraint (`btree_gist`) as a DB-level guardrail. Both are in the Scheduler Service DD, Section 3.4 — implement both, not just one.
- **Overlap semantics are half-open intervals**: two appointments that exactly touch (`EndTime` of one equals `StartTime` of the next) do **not** conflict. Getting this boundary backwards is an easy off-by-one — see Scheduler Service DD, Section 3.3's note.
- **`Idempotency-Key` is gateway-only.** It's required on every request, hashed and cached at the gateway (`(user, key) → { request hash, response }`, 10-min TTL), and is never part of the gRPC contract — don't add it back to the proto.
- **Rate limiting is gateway-enforced**, per authenticated user, on this endpoint specifically.
- **DB columns are PascalCase** (`DealershipId`, `IsActive`, `ServiceBayId`, matching the ERD); **proto/JSON fields are snake_case** (`dealership_id`, `vehicle_id`). Don't "fix" this into one consistent casing — it's an intentional, documented distinction between the two layers.
- **Business-hours/lunch-break/end-time calculation** has a specific algorithm (raw `end_time = start_time + Duration`, extended by 60 minutes if it spans the 12:00–13:00 lunch break, rejected if the result exceeds 18:00) — implement exactly as specified in Scheduler Service DD, Section 3.3, Step 2.
- **`AppointmentStatus` only has `CONFIRMED`.** No reschedule/cancel/no-show lifecycle — don't add extra enum values or status-transition logic.
- **Status code / HTTP mapping tables are exact contracts** — gateway DD Sections 2.6 and 2.8. Implement the mapping as a lookup, not through ad hoc error handling that might miss a case.
