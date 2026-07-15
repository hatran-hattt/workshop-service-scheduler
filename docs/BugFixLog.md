# Bug Fix Log

Tracks implementation bugs found during code review — i.e. code that deviated from the
detail design docs — and how each was fixed. This is distinct from
[`Design_Discussion_Log.md`](./Design_Discussion_Log.md), which records *design* decisions;
this file records *implementation* defects found after the design was already settled.

Each entry: what was wrong, which DD requirement it violated, status, and (once fixed) the fix
and the test(s) added to confirm it.

---

## 1. `validateTimeWindowAndComputeEndTime` — missing business-open-hour check (Rule 12)

- **Status:** Fixed.
- **Found:** 2026-07-15, code review of `apps/scheduler-service/src/create-appointment/create-appointment.service.ts`.
- **Where:** `validateTimeWindowAndComputeEndTime` (Scheduler Service, rules 8–12).
- **What was wrong:** Rule 12 requires the computed `[start_time, end_time]` range to fall
  entirely within business hours (09:00–18:00) — see `DD_Scheduler_Service_CreateAppointment.md`
  §3.2 rule 12, and `DesignDocument.md`'s "Appointment Time Constraints" ("Start time must be
  within business hours"). The implementation only checked the **closing** bound
  (`endTime > closingTime` against 18:00); nothing rejected a `start_time` before 09:00.
  Rules 8–11 don't cover this either (slot alignment, 15-min buffer, 1-month horizon, and
  lunch-break window respectively). A request like `start_time = 03:00 UTC` (15-min aligned,
  outside lunch, within the horizon) would incorrectly succeed.
- **Fix:** Added a `BUSINESS_OPEN_HOUR = 9` constant and a check that `start_time` is not
  before business open, as part of rule 12's block.
- **Tests added** (`create-appointment.service.spec.ts`, "Rule 12" describe block):
  - `start_time` at 08:45 → `INVALID_ARGUMENT`.
  - `start_time` exactly at 09:00 (boundary) → passes.

## 2. `validateTimeWindowAndComputeEndTime` — month-end overflow in the 1-month horizon (Rule 10)

- **Status:** Fixed.
- **Found:** 2026-07-15, same review.
- **Where:** `validateTimeWindowAndComputeEndTime`, rule 10 (`start_time` ≤ 1 month from today).
- **What was wrong:** The horizon date was computed with
  `horizonDate.setUTCMonth(horizonDate.getUTCMonth() + 1)`. JS `Date` silently overflows into a
  later month when the current day-of-month doesn't exist in the target month — e.g. today
  Jan 31 → naive horizon lands on Mar 2 (or Mar 3 in a non-leap year) instead of Feb 28/29. This
  widened the booking window by up to a few days on any day in the tail of a longer month rolling
  into a shorter one. Not caught by the existing tests, which only exercised a
  day-of-month that exists in both months (`Jan 14 → Feb 14`).
- **Interim fix (superseded, see below):** initially patched by detecting the `setUTCMonth`
  overflow and clamping back to the target month's last day. This worked but only patched around
  an interpretation the docs never actually specified — "1 month from today" has no single
  well-defined calendar meaning at month boundaries.
- **Final fix — design change, not just a code fix:** rather than codify a clamping convention the
  docs didn't ask for, rule 10 itself was redefined as a fixed **30-day** window instead of a
  calendar month (Design_Discussion_Log.md entry #82, candidate's decision). `DesignDocument.md`'s
  "Start Date" input line/note and `DD_Scheduler_Service_CreateAppointment.md` rule 10 were updated
  from "1 month" to "30 days"; `CLAUDE.md` and `Implementation_Testing_Plan.md` were updated for
  consistency. The code now computes the horizon as `todayUtc + 30 * 24h` in milliseconds —
  fixed-length day arithmetic in UTC has no DST or calendar-month-length ambiguity, so this
  eliminates the whole bug class rather than patching around it (no clamping logic needed at all).
- **Tests** (`create-appointment.service.spec.ts`, "Rule 10" describe block):
  - `start_time` exactly 30 days from today (boundary) → passes.
  - `start_time` 30 days + 1 day from today → `INVALID_ARGUMENT`.
  - (The Jan-31/Feb-29 leap-year clamp-boundary tests from the interim fix were removed — a fixed
    30-day window has no month-length-dependent boundary to test.)

## 3. `bookAppointmentSlot` — DB-unreachable errors never map to `UNAVAILABLE`

- **Status:** Fixed. Un-scoped back into this release (Design_Discussion_Log.md #84) — Scheduler
  DD §3.5's *Fallback on Failure* column is now implemented; §3.5's *Timeout* column (bug #4
  below) remains separately out of scope.
- **Found:** 2026-07-15, code review of Phase 2.5 (`bookAppointmentSlot`,
  `apps/scheduler-service/src/create-appointment/create-appointment.service.ts:234`).
- **Where:** `bookAppointmentSlot`.
- **What was wrong:** DD §3.5's External Dependencies table requires: *"Return `INTERNAL` on
  unexpected DB errors; return `UNAVAILABLE` if the DB is unreachable."* `await this.pool.connect()`
  (line 235) sat **outside** the function's own `try/catch`, so when the DB is unreachable the
  connection failure was never caught by this function's error-mapping logic at all — it wasn't
  even wrapped in an `RpcException`.
- **Verified live (pre-fix):** pointed a `Pool` at a closed port and called `bookAppointmentSlot`
  directly — the caught error was a raw `AggregateError { code: 'ECONNREFUSED' }`, not an
  `RpcException`. There's no custom gRPC exception filter registered (`main.ts` /
  `scheduler.controller.ts` are plain), so this would have surfaced to the gateway as whatever
  Nest's default handling produces — not the documented `UNAVAILABLE (14)` — breaking the
  gateway's retry-on-`UNAVAILABLE` contract (DD §2.4/3.5).
- **Fix:** moved `pool.connect()` inside the `try` (`client` is now `let client: PoolClient |
  undefined`, assigned inside); added a `NETWORK_ERROR_CODES` set (`ECONNREFUSED`, `ENOTFOUND`,
  `ETIMEDOUT`, `ECONNRESET`) and a `catch` branch mapping those to `status.UNAVAILABLE`, ahead of
  the generic `INTERNAL` fallback; guarded the rollback/`client.release()` calls with `client?.`
  since `client` can now be `undefined` if `connect()` itself failed.
- **Tests added** (`create-appointment.service.spec.ts`, `execute()` error-propagation block):
  - `pool.connect()` rejecting with `ECONNREFUSED` → `UNAVAILABLE`.
  - `pool.connect()` rejecting with a generic (non-network) error → `INTERNAL`.
  - (Also added coverage for `mapToResponse` and the rest of `execute()`'s status-code
    propagation from each validation stage, exported alongside this fix.)

## 4. `bookAppointmentSlot` / Pool config — no per-statement timeout configured

- **Status:** Out of scope for this release. Scheduler DD §3.5's *Timeout* column (which this bug
  is about) was explicitly marked out of scope for implementation this release — see
  `docs/ReleaseNotes.md` and `Design_Discussion_Log.md` #83. Revisit when that item moves back into
  scope.
- **Found:** 2026-07-15, same review.
- **Where:** `app.module.ts:11` (`Pool` construction) and `bookAppointmentSlot`.
- **What's wrong:** DD §3.5 specifies *"3s per statement, comfortably inside the gateway's 5s
  overall deadline."* No `statement_timeout`/`query_timeout` is configured on the `Pool`, and
  none is set per-transaction in `bookAppointmentSlot`. A hung query currently has no bound at
  all, contrary to this explicit (not inferred) DD requirement.
- **Planned fix:** set `statement_timeout` (e.g. via `SET LOCAL statement_timeout = 3000` inside
  the transaction, or `statement_timeout` in the `Pool` config) per DD §3.5.

## 5. Proto loader missing `keepCase: true` — all gRPC request fields silently received as `undefined`

- **Status:** Fixed.
- **Found:** 2026-07-15, Phase 2.8 gRPC black-box integration tests.
- **Where:** `apps/scheduler-service/src/main.ts` (server loader) and `apps/api-gateway/src/app.module.ts` (gateway client loader).
- **What was wrong:** `@grpc/proto-loader` defaults to `keepCase: false`, which converts every proto field name from `snake_case` to `camelCase` in the deserialized JavaScript object — so proto field `vehicle_id` becomes JavaScript key `vehicleId`. The loader options in both `main.ts` and the gateway's `ClientsModule` omitted `keepCase: true`, so the scheduler-service was receiving `{ vehicleId, dealershipId, workshopServiceId, startTime, requestedUserId }` while all service code (and the TypeScript interfaces) used snake_case (`request.vehicle_id`, etc.). Every field access returned `undefined`, causing `validateFormat` to reject every real request with `INVALID_ARGUMENT: vehicle_id must be a valid UUID`. This was masked throughout Phases 2.2–2.7 because all those tests called internal methods directly with hand-built snake_case objects, bypassing the gRPC transport entirely — the bug was only reachable through the wire.
- **Fix:** Added `keepCase: true` to the `loader` options in:
  - `apps/scheduler-service/src/main.ts` (production server entry point)
  - `apps/api-gateway/src/app.module.ts` (gateway gRPC client)
  - The in-process microservice started in `scheduler-grpc.spec.ts`'s `beforeAll` (test instance)
  - The raw `@grpc/grpc-js` client in the same `beforeAll` (already had it, confirmed correct)
- **Tests that caught it:** `scheduler-grpc.spec.ts` Phase 2.8 — every test that expected `NOT_FOUND`, `PERMISSION_DENIED`, or `ALREADY_EXISTS` was instead getting `INVALID_ARGUMENT` because the format check fired first on undefined fields.

## 6. `bookAppointmentSlot` — client released without being destroyed after a failed rollback

- **Status:** Open — deferred to next release. Low priority; not DD-mandated, a pg hygiene nit.
- **Found:** 2026-07-15, same review.
- **Where:** `bookAppointmentSlot`'s `catch`/`finally` blocks.
- **What's wrong:** `await client.query('ROLLBACK').catch(() => {})` swallows any error from the
  rollback itself; `finally` then unconditionally calls `client.release()`. If `ROLLBACK` fails
  (e.g. the connection is already broken), the client can be returned to the pool in a bad state
  (mid-transaction) and get reused by the next borrower. node-postgres's own guidance is
  `client.release(err)` (or `release(true)`) in that case, to destroy rather than recycle the
  connection.
- **Planned fix:** track whether `ROLLBACK` succeeded and call `client.release(err)` instead of
  `client.release()` when it didn't.
