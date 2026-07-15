/**
 * Full Scheduler Service gRPC integration suite [I]
 * Exercises CreateAppointment as a black box through the real gRPC transport.
 * Requires: running Postgres (`docker compose up -d postgres`).
 *
 * CreateAppointment — gRPC interface
 *   Success
 *     - happy path: valid request returns a confirmed appointment with correct shape
 *   Error — INVALID_ARGUMENT
 *     - malformed vehicle_id UUID (format validation, Rule 1)
 *     - start_time before business open at 08:45 (time-window validation, Rule 12)
 *   Error — NOT_FOUND
 *     - vehicle_id does not exist in Vehicle table (existence check, Rule 4)
 *   Error — PERMISSION_DENIED
 *     - vehicle belongs to a different user (ownership check, Rule 5)
 *   Error — ALREADY_EXISTS
 *     - all bays occupied for the requested slot (no availability)
 */

import 'dotenv/config';
import { join } from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { INestMicroservice } from '@nestjs/common';
import { Pool } from 'pg';
import { AppModule } from '../app.module';

const TEST_PORT = 5099;
const PROTO_PATH = join(__dirname, '../../../../proto/scheduler.proto');
const PROTO_INCLUDE = join(__dirname, '../../../../proto');

// Seed UUIDs from 02-seed.sql — leading digit encodes entity type
const D1       = '10000000-0000-0000-0000-000000000001';
const BAY_1    = '20000000-0000-0000-0000-000000000001'; // ServiceBay 1 (D1)
const BAY_2    = '20000000-0000-0000-0000-000000000002'; // ServiceBay 2 (D1)
const TECH_L1  = '30000000-0000-0000-0000-000000000001'; // Technician TechLevel 1 (D1)
const TECH_L2  = '30000000-0000-0000-0000-000000000002'; // Technician TechLevel 2 (D1)
const SVC_OIL  = '40000000-0000-0000-0000-000000000001'; // Oil Change — Duration 45 min
const VEHICLE_1 = '50000000-0000-0000-0000-000000000001'; // belongs to 'user-001'

interface Timestamp { seconds: number; nanos: number; }

interface GrpcRequest {
  vehicle_id: string;
  dealership_id: string;
  workshop_service_id: string;
  start_time: Timestamp;
  requested_user_id: string;
}

interface GrpcClient extends grpc.Client {
  createAppointment(
    req: GrpcRequest,
    cb: (err: grpc.ServiceError | null, res: any) => void,
  ): grpc.ClientUnaryCall;
}

// Tomorrow at 09:00 UTC — always valid: > 15 min buffer, within 30 days, on a 15-min boundary,
// within business hours, not in the lunch window.
function tomorrowAt9(): Timestamp {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(9, 0, 0, 0);
  return { seconds: Math.floor(d.getTime() / 1000), nanos: 0 };
}

// Oil Change (SVC_OIL) duration is 45 min, raw end = 09:45 — no lunch span, no extension.
function tomorrowAt945(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(9, 45, 0, 0);
  return d;
}

describe('CreateAppointment — gRPC integration [I]', () => {
  let app: INestMicroservice;
  let client: GrpcClient;
  let pool: Pool;

  beforeAll(async () => {
    // Start the real NestJS microservice on a dedicated test port
    app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      logger: false,
      transport: Transport.GRPC,
      options: {
        package: 'scheduler',
        protoPath: PROTO_PATH,
        url: `0.0.0.0:${TEST_PORT}`,
        loader: { keepCase: true, longs: Number, enums: String, includeDirs: [PROTO_INCLUDE] },
      },
    });
    await app.listen();

    // Create a gRPC client pointing at the test microservice
    const pkg = grpc.loadPackageDefinition(
      protoLoader.loadSync(PROTO_PATH, {
        keepCase: true, // preserve snake_case field names so GrpcRequest object keys are recognized
        longs: Number,
        enums: String,
        includeDirs: [PROTO_INCLUDE],
      }),
    ) as any;
    client = new pkg.scheduler.SchedulerService(
      `localhost:${TEST_PORT}`,
      grpc.credentials.createInsecure(),
    ) as GrpcClient;

    // Separate pool for test-side DB access (pre-occupying slots, cleaning state)
    pool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'localhost',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      database: process.env.POSTGRES_DB ?? 'workshop_scheduler',
      user: process.env.POSTGRES_USER ?? 'workshop',
      password: process.env.POSTGRES_PASSWORD ?? 'workshop_secret',
    });
  });

  afterAll(async () => {
    client.close();
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM "WorkshopServiceSchedule"');
  });

  function call(req: GrpcRequest): Promise<any> {
    return new Promise((resolve, reject) => {
      client.createAppointment(req, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  async function expectGrpcCode(fn: () => Promise<unknown>, code: grpc.status): Promise<void> {
    let thrown: unknown;
    try { await fn(); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect((thrown as grpc.ServiceError).code).toBe(code);
  }

  // Base request — every test overrides start_time at minimum
  const BASE: GrpcRequest = {
    vehicle_id: VEHICLE_1,
    dealership_id: D1,
    workshop_service_id: SVC_OIL,
    start_time: { seconds: 0, nanos: 0 }, // placeholder; overridden in every test
    requested_user_id: 'user-001',
  };

  // ─── Success ──────────────────────────────────────────────────────────────

  it('valid request returns a confirmed appointment with correct shape', async () => {
    const startTime = tomorrowAt9();
    const response = await call({ ...BASE, start_time: startTime });
    const appt = response.appointment;

    expect(appt.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(appt.vehicle_id).toBe(VEHICLE_1);
    expect(appt.dealership_id).toBe(D1);
    expect(appt.workshop_service_id).toBe(SVC_OIL);
    expect(appt.status).toBe('APPOINTMENT_STATUS_CONFIRMED');
    // start_time echoes the request; end_time = start + 45 min (Oil Change, no lunch span)
    expect(appt.start_time.seconds).toBe(startTime.seconds);
    expect(appt.end_time.seconds).toBe(startTime.seconds + 45 * 60);
    expect(typeof appt.created_at.seconds).toBe('number');
  });

  // ─── INVALID_ARGUMENT ─────────────────────────────────────────────────────

  it('malformed vehicle_id UUID returns INVALID_ARGUMENT', async () => {
    await expectGrpcCode(
      () => call({ ...BASE, vehicle_id: 'not-a-uuid', start_time: tomorrowAt9() }),
      grpc.status.INVALID_ARGUMENT,
    );
  });

  it('start_time before business open (08:45) returns INVALID_ARGUMENT', async () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(8, 45, 0, 0);
    await expectGrpcCode(
      () => call({ ...BASE, start_time: { seconds: Math.floor(d.getTime() / 1000), nanos: 0 } }),
      grpc.status.INVALID_ARGUMENT,
    );
  });

  // ─── NOT_FOUND ────────────────────────────────────────────────────────────

  it('non-existent vehicle_id returns NOT_FOUND', async () => {
    await expectGrpcCode(
      () => call({
        ...BASE,
        vehicle_id: '00000000-0000-0000-0000-000000000099',
        start_time: tomorrowAt9(),
      }),
      grpc.status.NOT_FOUND,
    );
  });

  // ─── PERMISSION_DENIED ────────────────────────────────────────────────────

  it('vehicle belonging to a different user returns PERMISSION_DENIED', async () => {
    await expectGrpcCode(
      () => call({ ...BASE, requested_user_id: 'other-user', start_time: tomorrowAt9() }),
      grpc.status.PERMISSION_DENIED,
    );
  });

  // ─── ALREADY_EXISTS ───────────────────────────────────────────────────────

  it('all bays occupied for the requested slot returns ALREADY_EXISTS', async () => {
    const startTime = tomorrowAt9();
    const endTime = tomorrowAt945();

    // Occupy both D1 bays — distinct technicians to satisfy the NoOverlapPerTechnician EXCLUDE constraint
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED'),
              ($1,$2,$3,$8,$9,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D1, SVC_OIL, BAY_1, TECH_L1, new Date(startTime.seconds * 1000), endTime, BAY_2, TECH_L2],
    );

    await expectGrpcCode(
      () => call({ ...BASE, start_time: startTime }),
      grpc.status.ALREADY_EXISTS,
    );
  });
});
