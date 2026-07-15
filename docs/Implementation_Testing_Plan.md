# Implementation & Testing Plan

Each numbered step below is meant to be independently reviewable — small enough to look at on its own, in order. Don't start step N+1 until N's tests pass.

**Build order:** infra → walking skeleton → **Scheduler Service** (the correctness-critical piece) → **API Gateway** (depends on Scheduler Service being callable) → a final full-stack edge-case/concurrency test pass (Phase 4 — re-runs the same cases end-to-end, through real HTTP, to catch anything the per-component tests in Phases 2–3 missed). Building Scheduler Service first means the Gateway is calling a real, already-tested service instead of a mock from the start.

**Test type key**, used throughout: **[U]** unit test (isolated, dependencies mocked) · **[I]** integration test (real Postgres/Redis via Docker) · **[C]** concurrency test (multiple simultaneous requests).

---

## Phase 0 — Repo & Infra Scaffold

- **0.1** Monorepo structure: two NestJS apps (`api-gateway`, `scheduler-service`) + a shared `proto/` folder for the `.proto` file both sides use.
- **0.2** `docker-compose.yml`: Postgres + Redis. `docker/init/01-schema.sql` (all 6 tables, `btree_gist`, both `EXCLUDE` constraints) and `02-seed.sql` (fixture dealerships/bays/technicians/services), per `CLAUDE.md` Section 2.
- **0.3** Sanity check only: connect to Postgres and Redis from each app on startup (e.g. a trivial `SELECT 1` / `PING`) and log success — proves the containers and connection strings work before any real logic is written.

---

## Phase 1 — Walking Skeleton (wiring only, no business logic)

- **1.1** Minimal `.proto` (can be a placeholder shape) + a Scheduler Service gRPC method that returns a hardcoded response.
- **1.2** Minimal Gateway controller that calls it and returns whatever it gets back — no auth, no validation, no idempotency.
- **1.3 [I]** One test: Gateway → gRPC call → Scheduler Service → response, proving the transport/wiring works end-to-end. This is the "hello world" step — it should be almost too simple to be interesting, and that's the point.

---

## Phase 2 — Scheduler Service

- **2.1** Scaffold the *real* proto (matching the detail design exactly) and the full module/controller/service structure with every method stubbed (`throw new NotImplementedException()`), so the shape of the final service is visible before any logic exists.
- **2.2 [U]** Format validation (rules 1–3: UUID/timestamp/presence checks). Cases: valid input; each field missing; each ID malformed; invalid timestamp string.
- **2.3 [U]** Existence & ownership (rules 4–7). Cases: vehicle not found; vehicle found but wrong owner; dealership not found; dealership inactive; service not found; service inactive; all valid.
- **2.4 [U]** Time-window validation + end-time calculation (rules 8–12 — this is the trickiest logic, worth its own isolated step). Cases:
  - Valid mid-morning slot, no lunch overlap.
  - Not aligned to a 15-min boundary.
  - Exactly 15 minutes from now (boundary) / 14 minutes from now (fails).
  - Exactly 30 days out (boundary) / 30 days + 1 day (fails).
  - Start time falls inside the lunch window itself.
  - Duration pushes end time to exactly 12:00 (boundary — does *not* need extension) vs. 12:01 (needs extension).
  - Duration + lunch extension lands exactly at 18:00 (boundary — should pass) vs. 18:01 (fails).
  - Start time already in the afternoon session (no lunch adjustment needed).
- **2.5 [I]** Availability check + locking + insert (Step 3 — needs a real Postgres instance, so this is integration-level even though it's testing one function). Cases:
  - Bay and technician both available → row inserted, correct fields.
  - No bay available at all.
  - No technician available at all.
  - No technician meets `TechLevel` (too low) vs. exactly meets it (boundary).
  - Existing appointment ends exactly when the new one starts (touching boundary — must **not** count as a conflict, per half-open semantics).
  - Existing appointment overlaps by one minute (must conflict).
  - Attempted direct insert bypassing the app (e.g. a raw `INSERT` in a second connection) — confirm the `EXCLUDE` constraint rejects it (`ABORTED` path). Optional/stretch if awkward to set up, but worth at least one test proving the DB-level guardrail actually fires, not just the app-level lock.
- **2.6 [U]** Response mapping + gRPC status codes (Step 4). Cases: success → `CreateAppointmentResponse` shape correct, including the lunch-adjusted `end_time`; each failure path from 2.2–2.5 maps to the correct gRPC status per the DD's Section 2.3 table.
- **2.7 [C]** Concurrency test: fire N simultaneous requests at the same dealership/time when only one bay (or one qualifying technician) remains. Assert exactly one succeeds and the rest get `ALREADY_EXISTS` (not a crash, not a duplicate booking, not more than one success).
- **2.8 [I]** Full Scheduler Service integration suite: run 2.2–2.7's cases through the actual gRPC interface (not calling internal functions directly), confirming the whole method behaves correctly as a black box.

---

## Phase 3 — API Gateway

By this point, Scheduler Service is complete and tested — the Gateway is now calling something real.

- **3.1** Scaffold: controller/module structure, all middleware/guards stubbed, main process wired to call the real Scheduler Service.
- **3.2 [U]** JWT auth guard. Cases: valid token; missing token; malformed token; expired token; wrong signature.
- **3.3 [U]** Format validation (headers + body shape per gateway DD 2.2/2.4). Cases: valid request; missing `Idempotency-Key`; missing `Authorization`; missing `Content-Type`; malformed UUID; malformed timestamp.
- **3.4 [U]** Idempotency logic (hash + cache check). Cases: new key → proceeds, response cached; same key + same body → cached response returned, downstream **not** called (verify with a spy/mock); same key + different body → `400`; TTL expiry (mock time or a short TTL in test).
- **3.5 [U]** Rate limiting. Cases: under limit → passes; at limit → `429`; limit resets after the window.
- **3.6 [U]** gRPC response → HTTP mapping (DD 2.8). Cases: one test per gRPC status code (`OK`, `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`, `ALREADY_EXISTS`, `ABORTED`, `RESOURCE_EXHAUSTED`, `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL`) → correct HTTP status + body shape, including the `error_code` split for the two `409` cases.
- **3.7 [I]** Full Gateway integration suite: real HTTP request → real gRPC call to the real (already-tested) Scheduler Service → real response, covering the happy path and at least one representative failure from each layer (auth, format, idempotency, rate limit, downstream error).

---

## Phase 4 — Full End-to-End Sweep

- **4.1 [I]** Happy path, client → Gateway → Scheduler Service → Postgres → response, using the seeded fixture data.
- **4.2 [I]** Run through the full coverage checklist below as automated tests (not just a manual pass) — anything not already covered by Phases 2–3 gets added here.
- **4.3 [C]** Repeat the Phase 2.7 concurrency test through the full stack (via HTTP, through the Gateway) rather than directly against Scheduler Service — confirms the Gateway's idempotency/rate-limit layers don't interfere with correct concurrent behavior.

---

## Coverage Checklist (cross-check before calling this done)

| Area | Case | Covered in |
|---|---|---|
| Format validation | Every field missing/malformed, both layers (Gateway format-only, Scheduler defensive re-check) | 2.2, 3.3 |
| Existence/ownership | Not found vs. inactive vs. wrong owner, each entity | 2.3 |
| Time rules | Every boundary in 2.4's list | 2.4 |
| Availability | Bay/technician found, not found, boundary skill level, boundary time-touching | 2.5 |
| Concurrency | Last-slot race, DB guardrail firing | 2.7, 4.3 |
| Status/error mapping | Every gRPC code, every HTTP code, the `409` split | 2.6, 3.6 |
| Auth | Valid/missing/malformed/expired token | 3.2 |
| Idempotency | New/replay/mismatch/expiry | 3.4 |
| Rate limiting | Under/at/reset | 3.5 |
| End-to-end | Happy path, at least one failure per layer | 3.7, 4.1 |

If a row's "Covered in" step doesn't actually exist yet or turns out incomplete when you get there, that's a signal to add a step — this table is the thing to check against, not the phase list above.
