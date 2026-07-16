# Workshop Service Scheduler

Implementation of one feature — **appointment booking** — for the Ownership domain of the
Automotive Retail Platform (ARP), built as a take-home technical assessment. A customer requests
a service appointment for a vehicle at a dealership; the system checks for a free Service Bay and
a qualified Technician for the full duration and, if available, creates a confirmed appointment.

Two components are implemented end-to-end:

| Component | Responsibility |
| --- | --- |
| **API Gateway** (`apps/api-gateway`) | `POST /api/v1/ownership/appointments` — REST entry point. JWT auth, request format validation, `Idempotency-Key` caching, per-user rate limiting, REST ↔ gRPC translation. |
| **Scheduler Service** (`apps/scheduler-service`) | `SchedulerService.CreateAppointment` (gRPC) — business-rule validation, availability check, and the transactional booking itself (row-locking + a DB `EXCLUDE` constraint as a second guardrail against double-booking). |

Everything else in the wider platform (real Identity Provider, event broker/notifications,
availability-cache read path, etc.) is out of scope — see [`CLAUDE.md`](CLAUDE.md) for the exact
scope boundary.

Full design detail lives in [`docs/`](docs/) — start with
[`docs/DesignDocument.md`](docs/DesignDocument.md), then the two contracts in
[`docs/detail_design/`](docs/detail_design/)
([`DD_API_Gateway_Appointments.md`](docs/detail_design/DD_API_Gateway_Appointments.md),
[`DD_Scheduler_Service_CreateAppointment.md`](docs/detail_design/DD_Scheduler_Service_CreateAppointment.md)),
and [`docs/Design_Discussion_Log.md`](docs/Design_Discussion_Log.md) for the reasoning behind
non-obvious decisions.

---

## Prerequisites

- Node.js LTS (developed/tested against Node 22)
- Docker (for Postgres + Redis)

## Setup

```bash
npm install
cp .env.example .env   # defaults work as-is for local dev
```

`.env` configures Postgres, Redis, the gRPC address between the two apps, and a fixed JWT signing
secret (the Identity Provider is stubbed — any token signed with this secret and a `sub` claim is
accepted as the requesting user's ID).

## Build

```bash
npm run build:gateway
npm run build:scheduler
```

## Run

### Mock data

On a fresh Postgres volume, startup auto-runs [`docker/init/01-schema.sql`](docker/init/01-schema.sql)
(schema) and [`docker/init/02-seed.sql`](docker/init/02-seed.sql) (fixtures) — there's nothing to
seed manually. The fixture rows relevant to a first request are:

| Entity | `Id` | Notes |
| --- | --- | --- |
| Dealership | `10000000-0000-0000-0000-000000000001` | active |
| ServiceBay | `20000000-0000-0000-0000-000000000001`, `...02` | 2 bays at the above dealership |
| Technician | `30000000-0000-0000-0000-000000000001` | `TechLevel = 1`, at the above dealership |
| WorkshopService | `40000000-0000-0000-0000-000000000001` | "Oil Change", `Duration = 45` min, `RequiredTechLevel = 1` |
| Vehicle | `50000000-0000-0000-0000-000000000001` | owned by `CustomerId = 'user-001'` |

(Full fixture set — a second dealership, more technicians at `TechLevel` 2/3, and a longer
`RequiredTechLevel = 3` service — is listed at the top of
[`docker/init/02-seed.sql`](docker/init/02-seed.sql) and mirrored as named constants in the test
files, e.g.
[`apps/scheduler-service/src/create-appointment/concurrency.spec.ts`](apps/scheduler-service/src/create-appointment/concurrency.spec.ts).)

### Steps

**1. Start Postgres and Redis** (bootstraps schema + fixtures on a fresh volume, per above):

```bash
docker compose up -d postgres redis
```

**2. Start the two services**, each in its own terminal:

```bash
npm run start:scheduler:dev   # gRPC server on SCHEDULER_GRPC_PORT (default 5000)
npm run start:gateway:dev     # REST server on API_GATEWAY_PORT (default 3000)
```

Wait for both to print their "listening" log line before continuing.

**3. Mint a token.** The Identity Provider is stubbed — any JWT signed with the shared test secret
(`JWT_SECRET` in `.env`) is accepted, and its `sub` claim becomes `requested_user_id`. This signs a
token for `user-001`, who owns the seeded vehicle above:

```bash
TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({ sub: 'user-001' }, 'test-jwt-secret-for-local-dev-only', { expiresIn: '1h' }))")
```

**4. Call the endpoint**, booking the seeded Oil Change for the seeded vehicle:

```bash
curl -i -X POST http://localhost:3000/api/v1/ownership/appointments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
        "vehicle_id": "50000000-0000-0000-0000-000000000001",
        "dealership_id": "10000000-0000-0000-0000-000000000001",
        "workshop_service_id": "40000000-0000-0000-0000-000000000001",
        "start_time": "2026-08-01T09:00:00Z"
      }'
```

(`start_time` must stay within 30 days of "today" as the container sees it — adjust the date
forward if you're running this well after 2026-08-01.)

### Expected output

`HTTP/1.1 201 Created`, with the system-assigned bay/technician and computed `end_time`
(`09:00` + the service's 45-minute `Duration`, no lunch-break extension needed at this hour):

```json
{
  "appointment_id": "<generated UUID>",
  "vehicle_id": "50000000-0000-0000-0000-000000000001",
  "dealership_id": "10000000-0000-0000-0000-000000000001",
  "workshop_service_id": "40000000-0000-0000-0000-000000000001",
  "service_bay_id": "20000000-0000-0000-0000-000000000001",
  "technician_id": "30000000-0000-0000-0000-000000000001",
  "start_time": "2026-08-01T09:00:00Z",
  "end_time": "2026-08-01T09:45:00Z",
  "status": "CONFIRMED",
  "created_at": "<current timestamp>"
}
```

Re-running the exact same `curl` command (same body, but a *new* `Idempotency-Key`, since bays are
single-occupancy) instead returns `409 Conflict` with `error_code: "NO_AVAILABILITY"` — the same
bay/technician pairing is now booked for that slot. Re-running with the *same* `Idempotency-Key`
returns the identical cached `201` response instead of creating a second appointment.

Full request/response shapes and the complete error-code table are in
[`docs/detail_design/DD_API_Gateway_Appointments.md`](docs/detail_design/DD_API_Gateway_Appointments.md),
Section 2.

## Test

```bash
docker compose up -d postgres redis   # required — most suites hit real Postgres/Redis, not mocks
npm test                              # all suites
npm run test:cov                      # with coverage
```

The suite is 10 files / 110 tests, mixing three levels (marked `[U]` / `[I]` / `[C]` in each
file's header comment):

- **`[U]` Unit** — validation-rule logic, JWT guard, idempotency hashing, rate-limit counting,
  and gRPC-status ↔ HTTP-status mapping, with dependencies mocked.
- **`[I]` Integration** — the real HTTP → gRPC → Postgres/Redis path, both black-box
  (`gateway.integration.spec.ts`, `scheduler-grpc.spec.ts`) and at the availability-check/locking
  function directly (`book-appointment-slot.spec.ts`).
- **`[C]` Concurrency** — fires N simultaneous requests at the same dealership/time slot when
  only one Service Bay or one qualifying Technician remains, and asserts exactly one booking
  succeeds (`concurrency.spec.ts`).

This is the feature's core correctness property — no double-booking under concurrent load — and
is exercised at two layers: the application-level `SELECT ... FOR UPDATE SKIP LOCKED` lock
(`concurrency.spec.ts`), and a direct raw `INSERT` that bypasses the app entirely to confirm the
Postgres `EXCLUDE` constraint independently rejects an overlap (`book-appointment-slot.spec.ts`,
`ABORTED` case).

`npm test` runs everything against the same `docker-compose` Postgres/Redis instance; there's no
separate "unit-only" script, since the majority of the business logic that matters
(availability, locking, boundary/half-open-interval overlap semantics) only proves itself against
a real database.

---

## AI Collaboration Narrative

Claude Code was the implementer; I stayed in control of the design and review. Workflow:

1. **Plan first.** Had Claude draft an implementation plan: infra → walking skeleton → each API,
   broken into small functions mapped to the detail design docs' own steps.
2. **`CLAUDE.md` as a standing contract.** Follow the DDs strictly, no assumptions — stop and ask
   before coding anything ambiguous.
3. **Implement phase by phase**, following the plan, instead of one long unsupervised pass.
4. **Review every phase:** I checked the code against the DD and read the tests Claude wrote. For
   higher-risk logic (e.g. concurrency/locking), I also had a *fresh* Claude session review it with
   no memory of writing it, and debugged the important test cases myself rather than trusting green
   output alone.
