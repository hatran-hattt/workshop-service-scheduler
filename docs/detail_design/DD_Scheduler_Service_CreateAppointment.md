# gRPC Method Detail Design — `SchedulerService.CreateAppointment`

## 1. Overview

- **Purpose:** Validate resource availability (Service Bay + qualified Technician) for a requested vehicle/dealership/service/time, and persist a confirmed `WorkshopServiceSchedule` record if available.
- **Consumers:** API Gateway (`POST /api/v1/ownership/appointments`).

---

## 2. Interface Design

### 2.1 Method

| Field    | Value                     |
| -------- | -------------------------- |
| Service  | `SchedulerService`        |
| Method   | `CreateAppointment`       |
| RPC Type | `Unary`                   |

### 2.2 Proto Definition

```protobuf
service SchedulerService {
  rpc CreateAppointment(CreateAppointmentRequest) returns (CreateAppointmentResponse);
}

message CreateAppointmentRequest {
  string vehicle_id = 1;
  string dealership_id = 2;
  string workshop_service_id = 3;
  google.protobuf.Timestamp start_time = 4;
  string requested_user_id = 5;
}

message CreateAppointmentResponse {
  Appointment appointment = 1;
}

message Appointment {
  string id = 1;
  string vehicle_id = 2;
  string dealership_id = 3;
  string workshop_service_id = 4;
  string service_bay_id = 5;
  string technician_id = 6;
  google.protobuf.Timestamp start_time = 7;
  google.protobuf.Timestamp end_time = 8;
  AppointmentStatus status = 9;
  google.protobuf.Timestamp created_at = 10;
}

enum AppointmentStatus {
  APPOINTMENT_STATUS_UNSPECIFIED = 0;
  APPOINTMENT_STATUS_CONFIRMED = 1;
}
```

### 2.3 Status Codes

| gRPC Status Code        | Condition                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `OK (0)`                 | Appointment successfully created.                                                              |
| `INVALID_ARGUMENT (3)`   | Malformed input, slot not aligned, time window violated — see 3.2.                              |
| `NOT_FOUND (5)`          | `vehicle_id`, `dealership_id`, or `workshop_service_id` doesn't exist or is inactive — see 3.2. |
| `PERMISSION_DENIED (7)`  | `vehicle_id` does not belong to `requested_user_id` — see 3.2/3.3. |
| `ALREADY_EXISTS (6)`     | No Service Bay + Technician combination was available for the requested time range at check time (normal "fully booked" outcome) — see 3.3, Step 3. |
| `ABORTED (10)`           | A conflicting row was caught by the DB-level guardrail after slipping past the application-level locks — rare in practice; see 3.4. |
| `INTERNAL (13)`          | Unexpected error (e.g. DB failure not related to the booking constraint). |
| `UNAVAILABLE (14)`       | Data layer unreachable — retryable by gateway per its policy. |

Note: `ALREADY_EXISTS` vs `ABORTED` split is implemented so the client can distinguish "genuinely no availability" from "lost a race for a slot that looked available a moment ago."

### 2.4 Notes

- **Streaming behavior:** N/A — unary RPC.
- **Deadline:** Recommended client-side (gateway) deadline: `5s`. Server-side, the DB transaction itself (check + insert) should complete well under this — see 3.4.

---

## 3. Business Logic Design

### 3.1 Request Flow

```
Gateway → Handler → Business Logic Layer → Data Layer → Response
```

Design convention: the gateway handles authentication and request-format validation before this RPC is called; this service defensively re-checks format and owns all business-rule validation.

### 3.2 Validation Rules

**Format check**

| # | Rule | Failure Behavior |
| - | ---- | ----------------- |
| 1 | `vehicle_id`, `dealership_id`, `workshop_service_id` must be present and valid UUID format | `INVALID_ARGUMENT` |
| 2 | `start_time` must be present and a valid timestamp | `INVALID_ARGUMENT` |
| 3 | `requested_user_id` must be present | `INVALID_ARGUMENT` |

**Business check**

| # | Rule | Failure Behavior |
| - | ---- | ----------------- |
| 4 | `vehicle_id` must exist in `Vehicle` | `NOT_FOUND` |
| 5 | `vehicle_id` must belong to `requested_user_id` (i.e. `Vehicle.CustomerId == requested_user_id`) | `PERMISSION_DENIED` |
| 6 | `dealership_id` must exist in `Dealership`, `IsActive = true` | `NOT_FOUND` |
| 7 | `workshop_service_id` must exist in `WorkshopService`, `IsActive = true` | `NOT_FOUND` |
| 8 | `start_time` must align to a 15-minute slot boundary | `INVALID_ARGUMENT` |
| 9 | `start_time` must be > 15 minutes from current time | `INVALID_ARGUMENT` |
| 10 | `start_time` must fall within a date ≤ 30 days from today | `INVALID_ARGUMENT` |
| 11 | `start_time` must not fall within the lunch break (12:00–13:00) | `INVALID_ARGUMENT` |
| 12 | Computed `[start_time, end_time]` range must fall within business hours (09:00–18:00), after extending `end_time` past the lunch break if the raw calculation spans it | `INVALID_ARGUMENT` |

Note: this is a deliberate consolidation — a single source of truth for these rules that also protects them if a future caller invokes this RPC directly, bypassing the gateway.

### 3.3 Core Processing Steps

**Steps 1–2 are read-only lookups/validation, executed before any transaction opens.**

1. **Validate format (rules 1–3), then existence and ownership (rules 4–7)**, in order — per 3.2. The `WorkshopService` lookup (rule 7) reads `Duration` and `RequiredTechLevel`, used respectively in Step 2 and Step 3.
2. **Validate `start_time` window rules (rules 8–11) and compute `end_time` (rule 12)**:
   - Compute raw `end_time = start_time + Duration`.
   - If `[start_time, raw end_time)` spans into or across the lunch break (i.e. `start_time < 12:00` and `raw end_time > 12:00`), extend: `end_time = raw end_time + 60 minutes`. (A `start_time` in the afternoon session never needs this adjustment.)
   - If the resulting `end_time` exceeds business close (18:00) → `INVALID_ARGUMENT` (rule 12).

**Step 3 is the atomic unit** (transaction scope and isolation level detailed in 3.4):

3. Open a transaction.
   - **Select + lock a candidate Service Bay**, combining the scope filter, the conflict check, and the lock into one statement:
     ```sql
     SELECT "Id" FROM "ServiceBay" sb
     WHERE sb."DealershipId" = :dealership_id
       AND sb."IsActive" = true
       AND NOT EXISTS (
         SELECT 1 FROM "WorkshopServiceSchedule" wss
         WHERE wss."ServiceBayId" = sb."Id"
           AND wss."StartTime" < :end_time AND wss."EndTime" > :start_time
       )
     FOR UPDATE SKIP LOCKED
     LIMIT 1;
     ```
     If no row is returned → roll back, return `ALREADY_EXISTS` (`error_code: NO_AVAILABILITY`, internal detail: "no service bay available").
   - **Select + lock a candidate Technician**, same pattern, additionally filtering by skill level:
     ```sql
     SELECT "Id" FROM "Technician" t
     WHERE t."DealershipId" = :dealership_id
       AND t."IsActive" = true
       AND t."TechLevel" >= :required_tech_level
       AND NOT EXISTS (
         SELECT 1 FROM "WorkshopServiceSchedule" wss
         WHERE wss."TechnicianId" = t."Id"
           AND wss."StartTime" < :end_time AND wss."EndTime" > :start_time
       )
     FOR UPDATE SKIP LOCKED
     LIMIT 1;
     ```
     If no row is returned → roll back (releasing the bay lock too — the bay is never consumed), return `ALREADY_EXISTS` (`error_code: NO_AVAILABILITY`, internal detail: "no technician available").
   - **Insert** the new `WorkshopServiceSchedule` row: `VehicleId`, `DealershipId`, `WorkshopServiceId`, `ServiceBayId`, `TechnicianId`, `StartTime`, `EndTime`, `RequestedUserId`, `Status = 'CONFIRMED'`, `CreatedAt = now()`.
   - Commit.

4. **Return result:** on success, map the inserted row to `CreateAppointmentResponse`. On failure, return the gRPC status determined above, per the codes already defined in 2.3.

Note: overlap comparisons above use half-open interval semantics (`"StartTime" < :end_time AND "EndTime" > :start_time`) — two appointments that exactly touch (one's `EndTime` equals another's `StartTime`) are **not** considered conflicting. State this explicitly since it's an easy off-by-one to get backwards.

Note (performance): the `NOT EXISTS` subqueries above require a composite index on `("ServiceBayId", "StartTime", "EndTime")` and `("TechnicianId", "StartTime", "EndTime")` on `WorkshopServiceSchedule` to perform acceptably under load — without it, each candidate check becomes a full scan.

### 3.4 Concurrency & Consistency

- **Locking strategy:** Pessimistic row locking with `SELECT ... FOR UPDATE SKIP LOCKED` on the candidate `ServiceBay` and `Technician` rows, combined with the overlap-check subquery in the same statement (see 3.3, Step 3). Locking the resource row itself is what makes this correct: it acts as a per-resource mutex, so two concurrent requests can never both proceed to insert conflicting rows for the same bay or technician. `SKIP LOCKED` means a transaction never blocks waiting on a row another transaction is already mid-booking — it simply tries the next candidate — which also means the fixed lock order (ServiceBay before Technician, always) can't produce an AB-BA deadlock.
- **Transaction scope:** the check-and-insert in Step 3 is one DB transaction at `READ COMMITTED` isolation (Postgres default) — see 3.3.
- **DB-level guardrail (defense-in-depth):** a Postgres `EXCLUDE` constraint (via `btree_gist`) guarantees no overlapping row can ever be inserted through *any* path (this service, a future internal tool, or a manual query), independent of whether that path correctly took the row locks above. A violation here maps to `ABORTED`.
  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;

  ALTER TABLE "WorkshopServiceSchedule"
    ADD CONSTRAINT "NoOverlapPerBay"
    EXCLUDE USING gist ("ServiceBayId" WITH =, tstzrange("StartTime", "EndTime") WITH &&);

  ALTER TABLE "WorkshopServiceSchedule"
    ADD CONSTRAINT "NoOverlapPerTechnician"
    EXCLUDE USING gist ("TechnicianId" WITH =, tstzrange("StartTime", "EndTime") WITH &&);
  ```
- **Practical effect on `ABORTED`:** given correct locking, two transactions can no longer race to insert the *same* conflicting row — the lock serializes that. `ABORTED` is therefore rare in practice (a defense-in-depth catch), reachable mainly if some insert path bypasses the row locks above.

### 3.5 External Dependencies

| Dependency | Timeout | Retry Policy | Fallback on Failure |
| ---------- | ------- | ------------ | -------------------- |
| Ownership domain database (Postgres) | 3s per statement, comfortably inside the gateway's 5s overall deadline (2.4) | No automatic retry on write conflicts — `SKIP LOCKED` means contended candidates are skipped rather than retried; a fully-exhausted candidate set returns `ALREADY_EXISTS` immediately, not via retry | Return `INTERNAL` on unexpected DB errors; return `UNAVAILABLE` if the DB is unreachable |

### 3.6 Edge Cases

| Case | Expected Behavior |
| ---- | ------------------ |
| Bay availability check passes but technician check fails (or vice versa) | Full failure — see 3.3, Step 3. |
| Two concurrent requests target the same last available bay/technician for overlapping times | Resolved by `SKIP LOCKED` — see 3.4. |
| `workshop_service_id` or `dealership_id` becomes inactive between the client's slot-list fetch and this request | `NOT_FOUND` — see 3.2. |
| A rogue insert bypasses this service's row locks entirely (e.g. a direct DB write or an unrelated process) | Caught by the DB-level guardrail — see 3.4; maps to `ABORTED`. |
