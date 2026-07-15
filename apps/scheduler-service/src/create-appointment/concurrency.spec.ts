/**
 * Concurrency tests for bookAppointmentSlot [C]
 * Requires a running Postgres instance (`docker compose up -d postgres`).
 *
 * bookAppointmentSlot — concurrency
 *   Last available ServiceBay
 *     - N concurrent requests, only one bay free: exactly 1 succeeds, N-1 get ALREADY_EXISTS
 *     - DB contains exactly 2 rows after the race (pre-inserted blocker + the one winner)
 *   Last qualifying Technician
 *     - N concurrent requests, only one technician meets RequiredTechLevel: exactly 1 succeeds, N-1 get ALREADY_EXISTS
 *     - DB contains exactly 1 row after the race (the winner)
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { CreateAppointmentService, BookSlotParams } from './create-appointment.service';

// Seed UUIDs from 02-seed.sql — leading digit encodes entity type
const D1       = '10000000-0000-0000-0000-000000000001';
const BAY_1    = '20000000-0000-0000-0000-000000000001'; // ServiceBay 1 (D1)
const TECH_L1  = '30000000-0000-0000-0000-000000000001'; // Technician TechLevel 1 (D1)
const TECH_L3  = '30000000-0000-0000-0000-000000000003'; // Technician TechLevel 3 (D1)
const SVC_OIL  = '40000000-0000-0000-0000-000000000001'; // Oil Change — Duration 45, RequiredTechLevel 1
const VEHICLE_1 = '50000000-0000-0000-0000-000000000001';

// Fixed slot well outside any real booking window
const T_09_00 = new Date('2030-06-15T09:00:00.000Z');
const T_09_45 = new Date('2030-06-15T09:45:00.000Z');

const BASE_PARAMS: BookSlotParams = {
  vehicleId: VEHICLE_1,
  dealershipId: D1,
  workshopServiceId: SVC_OIL,
  startTime: T_09_00,
  endTime: T_09_45,
  requiredTechLevel: 1,
  requestedUserId: 'user-001',
};

const CONCURRENCY = 5;

describe('bookAppointmentSlot — concurrency [C]', () => {
  let pool: Pool;
  let service: CreateAppointmentService;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'localhost',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      database: process.env.POSTGRES_DB ?? 'workshop_scheduler',
      user: process.env.POSTGRES_USER ?? 'workshop',
      password: process.env.POSTGRES_PASSWORD ?? 'workshop_secret',
    });
    service = new CreateAppointmentService(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM "WorkshopServiceSchedule"');
  });

  function isAlreadyExists(reason: unknown): boolean {
    return (
      reason instanceof RpcException &&
      (reason.getError() as { code: number }).code === status.ALREADY_EXISTS
    );
  }

  // ─── Last available ServiceBay ─────────────────────────────────────────────

  it('last bay: exactly 1 of N concurrent requests succeeds, the rest get ALREADY_EXISTS', async () => {
    // Pre-occupy BAY_1 with TECH_L1, leaving BAY_2 as the sole available bay
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D1, SVC_OIL, BAY_1, TECH_L1, T_09_00, T_09_45],
    );

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => service.bookAppointmentSlot(BASE_PARAMS)),
    );

    const successes    = results.filter(r => r.status === 'fulfilled');
    const alreadyExists = results.filter(r => r.status === 'rejected' && isAlreadyExists(r.reason));

    expect(successes).toHaveLength(1);
    expect(alreadyExists).toHaveLength(CONCURRENCY - 1);

    // Confirm no duplicate rows: pre-inserted blocker + exactly 1 winner = 2 total
    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM "WorkshopServiceSchedule"',
    );
    expect(Number(rows[0].count)).toBe(2);
  });

  // ─── Last qualifying Technician ────────────────────────────────────────────

  it('last qualifying technician: exactly 1 of N concurrent requests succeeds, the rest get ALREADY_EXISTS', async () => {
    // No bays pre-occupied. RequiredTechLevel 3 means only TECH_L3 qualifies.
    // Multiple transactions may each lock a different bay, but all race for the single eligible technician;
    // FOR UPDATE SKIP LOCKED ensures at most one acquires TECH_L3, the rest get no technician → ALREADY_EXISTS.
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        service.bookAppointmentSlot({ ...BASE_PARAMS, requiredTechLevel: 3 }),
      ),
    );

    const successes     = results.filter(r => r.status === 'fulfilled');
    const alreadyExists = results.filter(r => r.status === 'rejected' && isAlreadyExists(r.reason));

    expect(successes).toHaveLength(1);
    expect(alreadyExists).toHaveLength(CONCURRENCY - 1);

    // Winner's row uses TECH_L3
    const winner = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof service.bookAppointmentSlot>>>).value;
    expect(winner.TechnicianId).toBe(TECH_L3);

    // Exactly 1 row in DB — no duplicate bookings slipped through
    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM "WorkshopServiceSchedule"',
    );
    expect(Number(rows[0].count)).toBe(1);
  });
});
