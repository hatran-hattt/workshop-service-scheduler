/**
 * Full API Gateway integration suite [I]
 * Exercises POST /api/v1/ownership/appointments end-to-end:
 *   real HTTP (supertest) → real gRPC (Scheduler Service on test port) → real Postgres + Redis.
 * Requires: `docker compose up -d postgres redis`
 *
 * POST /api/v1/ownership/appointments
 *   Success
 *     - happy path: valid JWT + valid body → 201 with appointment data
 *     - idempotency replay: same Idempotency-Key + same body → 201 with cached (identical) response
 *   Error — 400 BAD_REQUEST
 *     - missing Idempotency-Key header
 *     - malformed vehicle_id (not a UUID)
 *     - Idempotency-Key reused with a different request body
 *   Error — 401 UNAUTHORIZED
 *     - missing Authorization header
 *     - expired JWT
 *   Error — 404 NOT_FOUND
 *     - vehicle_id does not exist in the Vehicle table
 *   Error — 409 CONFLICT / NO_AVAILABILITY
 *     - all service bays occupied for the requested slot
 *   Error — 429 TOO_MANY_REQUESTS
 *     - user exceeds 10 requests per minute (rate-limit counter exhausted)
 */

import 'dotenv/config';
import { join } from 'path';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { NestFactory } from '@nestjs/core';
import { INestApplication, INestMicroservice } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { AppModule } from '../app.module';
import { AppModule as SchedulerAppModule } from '../../../scheduler-service/src/app.module';

// ─── Test ports and constants ─────────────────────────────────────────────────

// Use a dedicated port to avoid collision with scheduler-grpc.spec.ts (5099)
const SCHEDULER_TEST_PORT = 5098;
const JWT_SECRET = 'test-jwt-secret-for-local-dev-only'; // FALLBACK_SECRET in jwt.guard.ts

const PROTO_PATH = join(__dirname, '../../../../proto/scheduler.proto');
const PROTO_INCLUDE = join(__dirname, '../../../../proto');

// Seed UUIDs from 02-seed.sql (leading digit encodes entity type)
const D1        = '10000000-0000-0000-0000-000000000001';
const BAY_1     = '20000000-0000-0000-0000-000000000001'; // ServiceBay 1 of D1
const BAY_2     = '20000000-0000-0000-0000-000000000002'; // ServiceBay 2 of D1
const TECH_L1   = '30000000-0000-0000-0000-000000000001'; // Technician TechLevel 1 (D1)
const TECH_L2   = '30000000-0000-0000-0000-000000000002'; // Technician TechLevel 2 (D1)
const SVC_OIL   = '40000000-0000-0000-0000-000000000001'; // Oil Change — Duration 45 min, RequiredTechLevel 1
const VEHICLE_1 = '50000000-0000-0000-0000-000000000001'; // owned by 'user-001'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeJwt(sub: string, expiresIn: string | number = '1h'): string {
  return jwt.sign({ sub }, JWT_SECRET, { expiresIn } as jwt.SignOptions);
}

// Tomorrow at 09:00 UTC — valid: > 15-min buffer, within 30-day window, 15-min boundary, business hours
function tomorrowAt9(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('POST /api/v1/ownership/appointments — Gateway integration [I]', () => {
  let gatewayApp: INestApplication;
  let schedulerApp: INestMicroservice;
  let pool: Pool;
  let redis: Redis;

  beforeAll(async () => {
    // Point gateway's gRPC client at the test scheduler port (read by AppModule's useFactory)
    process.env['SCHEDULER_GRPC_HOST'] = 'localhost';
    process.env['SCHEDULER_GRPC_PORT'] = String(SCHEDULER_TEST_PORT);

    // Start the Scheduler Service (gRPC) on a dedicated test port
    schedulerApp = await NestFactory.createMicroservice<MicroserviceOptions>(SchedulerAppModule, {
      logger: false,
      transport: Transport.GRPC,
      options: {
        package: 'scheduler',
        protoPath: PROTO_PATH,
        url: `0.0.0.0:${SCHEDULER_TEST_PORT}`,
        loader: { keepCase: true, longs: Number, enums: String, includeDirs: [PROTO_INCLUDE] },
      },
    });
    await schedulerApp.listen();

    // Start the API Gateway HTTP server; it will connect to the scheduler at SCHEDULER_TEST_PORT
    gatewayApp = await NestFactory.create(AppModule, { logger: false });
    await gatewayApp.init();

    // Direct DB connection for pre-occupying slots and cleaning state between tests
    pool = new Pool({
      host: process.env['POSTGRES_HOST'] ?? 'localhost',
      port: Number(process.env['POSTGRES_PORT'] ?? 5432),
      database: process.env['POSTGRES_DB'] ?? 'workshop_scheduler',
      user: process.env['POSTGRES_USER'] ?? 'workshop',
      password: process.env['POSTGRES_PASSWORD'] ?? 'workshop_secret',
    });

    // Redis client for flushing rate-limit and idempotency state before each run
    redis = new Redis({
      host: process.env['REDIS_HOST'] ?? 'localhost',
      port: Number(process.env['REDIS_PORT'] ?? 6379),
    });
    await redis.flushdb();
  }, 20_000);

  afterAll(async () => {
    await gatewayApp.close();
    await schedulerApp.close();
    await pool.end();
    await redis.quit();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM "WorkshopServiceSchedule"');
  });

  // ─── Base objects ─────────────────────────────────────────────────────────

  const BASE_BODY = {
    vehicle_id: VEHICLE_1,
    dealership_id: D1,
    workshop_service_id: SVC_OIL,
    start_time: '', // overridden per test
  };

  function baseHeaders(idempotencyKey: string, token: string) {
    return {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': idempotencyKey,
      'Content-Type': 'application/json',
    };
  }

  // ─── Success ─────────────────────────────────────────────────────────────

  it('201: valid JWT + valid body returns a confirmed appointment', async () => {
    const token = makeJwt('user-001');
    const body = { ...BASE_BODY, start_time: tomorrowAt9() };

    const res = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set(baseHeaders('idem-key-happy', token))
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.appointment_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(res.body.vehicle_id).toBe(VEHICLE_1);
    expect(res.body.dealership_id).toBe(D1);
    expect(res.body.status).toBe('CONFIRMED');
    expect(res.body.start_time).toBe(tomorrowAt9());
  });

  it('201: idempotency replay — same key + same body returns cached response', async () => {
    const token = makeJwt('user-001');
    const body = { ...BASE_BODY, start_time: tomorrowAt9() };
    const headers = baseHeaders('idem-key-replay', token);

    const first = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set(headers)
      .send(body);
    expect(first.status).toBe(201);

    // Second request with same key and body — gateway must return cached result, not call gRPC again
    const second = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set(headers)
      .send(body);
    expect(second.status).toBe(201);
    expect(second.body.appointment_id).toBe(first.body.appointment_id);
  });

  // ─── 400 BAD_REQUEST ─────────────────────────────────────────────────────

  it('400: missing Idempotency-Key header', async () => {
    const token = makeJwt('user-001');
    const res = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
      .send({ ...BASE_BODY, start_time: tomorrowAt9() });

    expect(res.status).toBe(400);
  });

  it('400: vehicle_id is not a valid UUID', async () => {
    const token = makeJwt('user-001');
    const res = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set(baseHeaders('idem-key-bad-uuid', token))
      .send({ ...BASE_BODY, vehicle_id: 'not-a-uuid', start_time: tomorrowAt9() });

    expect(res.status).toBe(400);
  });

  it('400: Idempotency-Key reused with a different body', async () => {
    const token = makeJwt('user-001');
    const key = 'idem-key-conflict';

    const first = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set(baseHeaders(key, token))
      .send({ ...BASE_BODY, start_time: tomorrowAt9() });
    expect(first.status).toBe(201);

    // Same key but start_time shifted to 10:00 — body hash differs
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(10, 0, 0, 0);

    const second = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set(baseHeaders(key, token))
      .send({ ...BASE_BODY, start_time: d.toISOString() });
    expect(second.status).toBe(400);
  });

  // ─── 401 UNAUTHORIZED ────────────────────────────────────────────────────

  it('401: missing Authorization header', async () => {
    const res = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set({ 'Idempotency-Key': 'idem-401', 'Content-Type': 'application/json' })
      .send({ ...BASE_BODY, start_time: tomorrowAt9() });

    expect(res.status).toBe(401);
  });

  it('401: expired JWT', async () => {
    const expiredToken = makeJwt('user-001', '-1s');
    const res = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set(baseHeaders('idem-expired', expiredToken))
      .send({ ...BASE_BODY, start_time: tomorrowAt9() });

    expect(res.status).toBe(401);
  });

  // ─── 404 NOT_FOUND (downstream gRPC error propagated through gateway) ────

  it('404: vehicle_id not in database', async () => {
    const token = makeJwt('user-001');
    const unknownVehicle = '99999999-0000-0000-0000-000000000099';
    const res = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set(baseHeaders('idem-key-404', token))
      .send({ ...BASE_BODY, vehicle_id: unknownVehicle, start_time: tomorrowAt9() });

    expect(res.status).toBe(404);
  });

  // ─── 409 CONFLICT / NO_AVAILABILITY ─────────────────────────────────────

  it('409 NO_AVAILABILITY: all bays at dealership occupied for the requested slot', async () => {
    const startTime = tomorrowAt9();
    const startMs = new Date(startTime).getTime();
    const endTs = new Date(startMs + 45 * 60 * 1000).toISOString(); // Oil Change = 45 min

    // Pre-occupy both D1 bays — use different technicians to satisfy the technician EXCLUDE constraint
    await pool.query(`
      INSERT INTO "WorkshopServiceSchedule"
        ("Id","VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status","CreatedAt","UpdatedAt")
      VALUES
        (gen_random_uuid(),'${VEHICLE_1}','${D1}','${SVC_OIL}','${BAY_1}','${TECH_L1}','${startTime}','${endTs}','user-001','APPOINTMENT_STATUS_CONFIRMED',NOW(),NOW()),
        (gen_random_uuid(),'${VEHICLE_1}','${D1}','${SVC_OIL}','${BAY_2}','${TECH_L2}','${startTime}','${endTs}','user-001','APPOINTMENT_STATUS_CONFIRMED',NOW(),NOW())
    `);

    const token = makeJwt('user-001');
    const res = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set(baseHeaders('idem-key-409', token))
      .send({ ...BASE_BODY, start_time: startTime });

    expect(res.status).toBe(409);
    expect(res.body.error_code).toBe('NO_AVAILABILITY');
  });

  // ─── 429 TOO_MANY_REQUESTS (rate-limit layer) ────────────────────────────

  it('429: user exceeds 10 requests per minute', async () => {
    // Use a dedicated sub claim so this test does not deplete the rate-limit counter for other tests
    const token = makeJwt('user-rate-limit-test');

    // Send 10 requests that pass auth + rate-limit but fail format validation (no Idempotency-Key).
    // Rate-limit guard increments INCR before format validation runs — counter reaches 10 after loop.
    for (let i = 0; i < 10; i++) {
      const res = await request(gatewayApp.getHttpServer())
        .post('/api/v1/ownership/appointments')
        .set({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
        .send({ ...BASE_BODY, start_time: tomorrowAt9() });
      // 400 from format validation (missing Idempotency-Key), not 429 yet
      expect(res.status).toBe(400);
    }

    // 11th request — rate-limit guard rejects before format validation
    const limited = await request(gatewayApp.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .set({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
      .send({ ...BASE_BODY, start_time: tomorrowAt9() });
    expect(limited.status).toBe(429);
  });
});
