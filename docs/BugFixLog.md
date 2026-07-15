# Bug Fix Log

Tracks implementation bugs found during code review — i.e. code that deviated from the
detail design docs — and how each was fixed. This is distinct from
[`Design_Discussion_Log.md`](./Design_Discussion_Log.md), which records *design* decisions;
this file records *implementation* defects found after the design was already settled.

Each entry: what was wrong, which DD requirement it violated, the fix, and the test(s) added
to confirm it.

---

## 1. `validateTimeWindowAndComputeEndTime` — missing business-open-hour check (Rule 12)

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
