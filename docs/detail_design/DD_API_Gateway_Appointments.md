# RESTful API Detail Design — `POST /api/v1/ownership/appointments`

## 1. Overview

- **Purpose:** Allow an authenticated customer to request a service (workshop) appointment for one of their vehicles, at a specific dealership, for a specific service type and start time. The gateway validates request format and forwards the request to the downstream gRPC service, which performs availability checks and persists the appointment.
- **Consumers:** Scheduler Application (customer-facing client).
- **Downstream gRPC method:** `SchedulerService.CreateAppointment`

---

## 2. Interface Design

### 2.1 Endpoint

| Method | Path                        | Description                             | Auth Required |
| ------ | --------------------------- | ---------------------------------------- | -------------- |
| `POST` | `/api/v1/ownership/appointments` | Request a new service appointment | Yes |

### 2.2 Headers

| Header            | Required | Description                                                                 |
| ------------------ | -------- | ---------------------------------------------------------------------------- |
| `Authorization`    | Yes      | `Bearer <JWT>` — issued by the Identity Provider; supplies `requested_user_id` (see 2.8).            |
| `Idempotency-Key`  | Yes      | Client-generated UUID, one per booking attempt. Used by the gateway to deduplicate retries (see 2.7). Not forwarded downstream. |
| `Content-Type`     | Yes      | Must be `application/json`.                                                  |

### 2.3 Path / Query Parameters

None — all inputs are supplied in the request body. This endpoint creates a new resource; it does not operate on an existing `{id}`.

### 2.4 Request Body

```json
{
  "vehicle_id": "string",
  "dealership_id": "string",
  "workshop_service_id": "string",
  "start_time": "2026-08-01T09:00:00Z"
}
```

| Field                 | Type     | Required | Constraints                                  | Description                                                        |
| --------------------- | -------- | -------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `vehicle_id`          | `string` | Yes      | Valid UUID format                             | The vehicle the appointment is for.                                 |
| `dealership_id`       | `string` | Yes      | Valid UUID format                             | The dealership where the service will be performed.                 |
| `workshop_service_id` | `string` | Yes      | Valid UUID format                             | The type of service being requested.                                 |
| `start_time`          | `string` | Yes      | Valid ISO 8601 UTC timestamp                  | Requested start of the appointment. End time is server-computed based on the selected service's standard duration. |

Design convention: gateway endpoints validate request format only; all other validation is the responsibility of the downstream service.

### 2.5 Response — Success

`Status: 201 Created`

```json
{
  "appointment_id": "string",
  "vehicle_id": "string",
  "dealership_id": "string",
  "workshop_service_id": "string",
  "service_bay_id": "string",
  "technician_id": "string",
  "start_time": "2026-08-01T09:00:00Z",
  "end_time": "2026-08-01T09:45:00Z",
  "status": "CONFIRMED",
  "created_at": "2026-07-14T08:00:00Z"
}
```

| Field                 | Type     | Description                                              |
| --------------------- | -------- | ---------------------------------------------------------- |
| `appointment_id`      | `string` | Server-generated ID of the created appointment record. |
| `service_bay_id`      | `string` | Bay assigned by the system (not chosen by the user).       |
| `technician_id`       | `string` | Technician assigned by the system (not chosen by the user). |
| `end_time`            | `string` | End time is server-computed based on the selected service's standard duration. |
| `status`              | `string` | Appointment status. Only `"CONFIRMED"` is produced in this scope — reschedule/cancel/no-show lifecycle states are out of scope and do not exist yet. |

### 2.6 Response — Errors

| Status | Error Code            | Condition                                                                 |
| ------ | ---------------------- | -------------------------------------------------------------------------- |
| `400`  | `INVALID_ARGUMENT`     | Malformed request (invalid UUID/timestamp format, missing/invalid headers), `Idempotency-Key` reused with a mismatched body, or a scheduling business-rule violation (validated downstream). |
| `401`  | `UNAUTHENTICATED`      | Missing/invalid JWT.                                                       |
| `403`  | `PERMISSION_DENIED`    | `vehicle_id` does not belong to the authenticated user (validated downstream). |
| `404`  | `NOT_FOUND`            | `vehicle_id`, `dealership_id`, or `workshop_service_id` does not exist or is not currently available (validated downstream). |
| `409`  | `CONFLICT`             | Distinguished by `error_code` in the response body: `NO_AVAILABILITY` — no resource combination available for the requested time; client should pick a different slot. `BOOKING_CONFLICT` — the selected resource pairing was lost to a competing booking; client should resubmit the identical request a bounded number of times before falling back to re-fetching availability. |
| `429`  | `RESOURCE_EXHAUSTED`   | Rate limit exceeded. |
| `500`  | `INTERNAL`             | Unexpected server error. |
| `503`  | `UNAVAILABLE`          | Downstream service unreachable or signaling it cannot serve the request. |
| `504`  | `DEADLINE_EXCEEDED`    | The call to the downstream service did not complete within its deadline (`5s`, see 3.3). Outcome is unknown — client should check current state before retrying, not resubmit blindly. |

`409` error body shape:

```json
{
  "error_code": "NO_AVAILABILITY | BOOKING_CONFLICT",
  "message": "string"
}
```

### 2.7 Notes

- **Idempotency:** Enforced at the gateway via the required `Idempotency-Key` header (see 2.2). The gateway caches `(authenticated user, Idempotency-Key) → { request body hash, response }` for 10 minutes.
  - Same key, matching hash: cached response returned; downstream not called again.
  - Same key, non-matching hash: `400 INVALID_ARGUMENT` (key reused for a different request).
  - Missing header: `400 INVALID_ARGUMENT`.
  
  Not part of the gRPC request contract (see 2.8) — resolved entirely at the gateway; the downstream service has no dedup responsibility.
- **Pagination:** N/A — this is a create endpoint.
- **Rate limiting:** Enforced at the gateway, per authenticated user, on this endpoint specifically (e.g. 10 requests/minute) — booking attempts are naturally infrequent, so this bounds retry storms/abuse without affecting normal usage. Exceeding the limit returns `429 RESOURCE_EXHAUSTED`.

### 2.8 REST ↔ gRPC Mapping

**Request mapping**

| REST Field (source)             | gRPC Request Field                        | Notes                              |
| --------------------------------- | ------------------------------------------ | ------------------------------------ |
| `vehicle_id`                    | `CreateAppointmentRequest.vehicle_id`      | Direct copy                         |
| `dealership_id`                 | `CreateAppointmentRequest.dealership_id`   | Direct copy                         |
| `workshop_service_id`           | `CreateAppointmentRequest.workshop_service_id` | Direct copy                     |
| `start_time`                    | `CreateAppointmentRequest.start_time`      | Direct copy (RFC 3339 → protobuf `Timestamp`) |
| JWT subject (from auth context) | `CreateAppointmentRequest.requested_user_id` | Extracted from validated token, not from request body |

Note: `Idempotency-Key` (2.2, 2.7) is resolved at the gateway and not forwarded — the downstream service is unaware of it.

**Response mapping**

| gRPC Response Field                    | REST Field (output)   | Notes                                        |
| ----------------------------------------- | ------------------------ | ----------------------------------------------- |
| `Appointment.id`                       | `appointment_id`       | Direct copy                                   |
| `Appointment.service_bay_id`           | `service_bay_id`       | Direct copy                                   |
| `Appointment.technician_id`            | `technician_id`        | Direct copy                                   |
| `Appointment.start_time` / `end_time`  | `start_time` / `end_time` | protobuf `Timestamp` → ISO 8601             |
| `Appointment.status` (enum)            | `status` (string)      | e.g. `APPOINTMENT_STATUS_CONFIRMED` → `"CONFIRMED"` |

**Status code mapping**

| gRPC Status                         | HTTP Status   |
| ------------------------------------ | -------------- |
| `OK`                                 | `201`          |
| `INVALID_ARGUMENT`                   | `400`          |
| `UNAUTHENTICATED`                    | `401`          |
| `PERMISSION_DENIED`                  | `403`          |
| `NOT_FOUND`                          | `404`          |
| `ALREADY_EXISTS`                     | `409` (`error_code: NO_AVAILABILITY`) |
| `ABORTED`                             | `409` (`error_code: BOOKING_CONFLICT`) |
| `RESOURCE_EXHAUSTED`                 | `429`          |
| `UNAVAILABLE` / `DEADLINE_EXCEEDED`  | `503` / `504`  |
| `INTERNAL`                           | `500`          |

Note: `ABORTED` means the requested slot was lost to a competing booking; `ALREADY_EXISTS` means no slot was ever available.

---

## 3. Business Logic Design

### 3.1 Request Flow

```
Client → Auth (JWT via IdP) → Validation → Idempotency Check → REST Handler → gRPC Client Stub → Call Downstream gRPC Method → Response Mapping → Cache Response → Response
```

### 3.2 Core Processing Steps

1. Authenticate request via JWT (Identity Provider-issued token); reject if missing/invalid.
2. Validate input format per 2.2/2.4 (UUID format, timestamp format, `Idempotency-Key` presence).
3. Compute a hash of the canonicalized request body, then check the idempotency store for `(authenticated user, Idempotency-Key)`. If found and the stored hash matches, return the cached response immediately (skip steps 4–6). If found with a non-matching hash, return `400`.
4. Map REST request → gRPC `CreateAppointmentRequest`, injecting `requested_user_id` from the validated token (not trusting a client-supplied value). `Idempotency-Key` is not included (see 2.8).
5. Call downstream gRPC method: `SchedulerService.CreateAppointment`.
6. Map gRPC response/status → REST response/HTTP status per 2.8.
7. Cache `{ request body hash, response }` against `(authenticated user, Idempotency-Key)` with a 10-minute TTL.
8. Return response to client.

### 3.3 Downstream gRPC Call

| Dependency                          | Call Type | Deadline | Retry Policy                                                                 | Fallback on Failure |
| -------------------------------------- | ----------- | ---------- | -------------------------------------------------------------------------------- | ---------------------- |
| `SchedulerService.CreateAppointment` | `sync`    | `5s`     | No automatic retry on timeout | Return `503` to client |

### 3.4 Edge Cases

| Case                                                       | Expected Behavior                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| gRPC call times out                                        | Return `504` to client (see 2.6 for client-facing guidance).             |
| gRPC returns `UNAVAILABLE`                                  | Return `503`. |
| gRPC returns `ABORTED` (lost the selected resource pairing) | Return `409` (`error_code: BOOKING_CONFLICT`); see 2.6 for client-facing guidance. |
| Client submits request with an `Idempotency-Key` already seen for a *different* payload | `400 INVALID_ARGUMENT` (see 2.7). |
| Client omits `Idempotency-Key`                             | `400 INVALID_ARGUMENT` (see 2.2, 2.7). |
| Client exceeds the per-user rate limit on this endpoint    | `429 RESOURCE_EXHAUSTED` (see 2.7). |
