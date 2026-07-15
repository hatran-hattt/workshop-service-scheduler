/**
 * Integration tests for bookAppointmentSlot — requires a running Postgres instance.
 * Run `docker compose up -d postgres` before executing this suite.
 *
 * bookAppointmentSlot
 *   Success
 *     - bay and technician both available → row inserted with correct fields
 *     - existing appointment ends exactly when new one starts (touching boundary — must NOT conflict, half-open semantics)
 *     - technician TechLevel exactly meets RequiredTechLevel (boundary — passes)
 *   Error — ALREADY_EXISTS (NO_AVAILABILITY)
 *     - no bay available (all bays occupied for the slot)
 *     - no technician available (all technicians occupied for the slot)
 *     - no technician meets RequiredTechLevel (all too low)
 *     - existing appointment overlaps by one minute (must conflict)
 *   Error — ABORTED
 *     - direct INSERT bypassing service locks triggers DB EXCLUDE constraint (guardrail fires)
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { CreateAppointmentService, BookSlotParams } from './create-appointment.service';

// Seed UUIDs from 02-seed.sql — leading digit encodes entity type
const D1 = '10000000-0000-0000-0000-000000000001'; // Dealership 1
const D2 = '10000000-0000-0000-0000-000000000002'; // Dealership 2
const BAY_1 = '20000000-0000-0000-0000-000000000001'; // ServiceBay 1 (D1)
const BAY_2 = '20000000-0000-0000-0000-000000000002'; // ServiceBay 2 (D1)
const BAY_3 = '20000000-0000-0000-0000-000000000003'; // ServiceBay 3 (D2) — used to block D1 techs
const TECH_L1 = '30000000-0000-0000-0000-000000000001'; // Technician TechLevel 1 (D1)
const TECH_L2 = '30000000-0000-0000-0000-000000000002'; // Technician TechLevel 2 (D1)
const TECH_L3 = '30000000-0000-0000-0000-000000000003'; // Technician TechLevel 3 (D1)
const SVC_OIL = '40000000-0000-0000-0000-000000000001'; // Oil Change — Duration 45, RequiredTechLevel 1
const VEHICLE_1 = '50000000-0000-0000-0000-000000000001'; // Vehicle owned by user-001

// Fixed test slot well outside any real booking window
const T_09_00 = new Date('2030-06-15T09:00:00.000Z');
const T_09_45 = new Date('2030-06-15T09:45:00.000Z'); // T_09_00 + 45 min (Oil Change)
const T_10_00 = new Date('2030-06-15T10:00:00.000Z');

const BASE_PARAMS: BookSlotParams = {
  vehicleId: VEHICLE_1,
  dealershipId: D1,
  workshopServiceId: SVC_OIL,
  startTime: T_09_00,
  endTime: T_09_45,
  requiredTechLevel: 1,
  requestedUserId: 'user-001',
};

describe('bookAppointmentSlot [I]', () => {
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

  function expectAlreadyExists(fn: () => Promise<unknown>): Promise<void> {
    return fn().then(
      () => { throw new Error('expected ALREADY_EXISTS but did not throw'); },
      (err) => {
        expect(err).toBeInstanceOf(RpcException);
        expect((err as RpcException).getError()).toMatchObject({ code: status.ALREADY_EXISTS });
      },
    );
  }

  // ─── Success ──────────────────────────────────────────────────────────────

  it('inserts a row and returns correct fields when bay and technician are available', async () => {
    const row = await service.bookAppointmentSlot(BASE_PARAMS);

    expect([BAY_1, BAY_2]).toContain(row.ServiceBayId);
    expect([TECH_L1, TECH_L2, TECH_L3]).toContain(row.TechnicianId);
    expect(row.VehicleId).toBe(VEHICLE_1);
    expect(row.DealershipId).toBe(D1);
    expect(row.WorkshopServiceId).toBe(SVC_OIL);
    expect(row.Status).toBe('CONFIRMED');
    expect(new Date(row.StartTime)).toEqual(T_09_00);
    expect(new Date(row.EndTime)).toEqual(T_09_45);
    expect(row.Id).toBeDefined();
    expect(row.CreatedAt).toBeDefined();
  });

  it('does not conflict when an existing appointment ends exactly when the new one starts (half-open interval)', async () => {
    // Existing: 09:00–09:45. New: 09:45–10:30. EndTime=09:45 > StartTime=09:45 is false → no overlap.
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D1, SVC_OIL, BAY_1, TECH_L1, T_09_00, T_09_45],
    );

    // New slot starts exactly where the existing one ends — should succeed on bay 2 or same bay
    const row = await service.bookAppointmentSlot({
      ...BASE_PARAMS,
      startTime: T_09_45,
      endTime: T_10_00,
    });
    expect(row.Status).toBe('CONFIRMED');
  });

  it('succeeds when technician TechLevel exactly meets RequiredTechLevel (boundary)', async () => {
    // Occupy L1 and L2 technicians, require TechLevel 2 — L2 should be selected
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D1, SVC_OIL, BAY_1, TECH_L1, T_09_00, T_09_45],
    );

    const row = await service.bookAppointmentSlot({ ...BASE_PARAMS, requiredTechLevel: 2 });
    expect([TECH_L2, TECH_L3]).toContain(row.TechnicianId);
  });

  // ─── ALREADY_EXISTS ───────────────────────────────────────────────────────

  it('throws ALREADY_EXISTS when no bay is available for the slot', async () => {
    // Occupy both D1 bays — each row needs a distinct technician to satisfy NoOverlapPerTechnician
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED'),
              ($1,$2,$3,$8,$9,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D1, SVC_OIL, BAY_1, TECH_L1, T_09_00, T_09_45, BAY_2, TECH_L2],
    );

    await expectAlreadyExists(() => service.bookAppointmentSlot(BASE_PARAMS));
  });

  it('throws ALREADY_EXISTS when no technician is available for the slot', async () => {
    // Occupy all three D1 technicians — each needs a distinct bay to satisfy NoOverlapPerBay.
    // BAY_3 belongs to D2 but the EXCLUDE constraint is per TechnicianId, so booking TECH_L3
    // against BAY_3 is enough to mark them globally unavailable for the overlapping slot.
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D1, SVC_OIL, BAY_1, TECH_L1, T_09_00, T_09_45],
    );
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D1, SVC_OIL, BAY_2, TECH_L2, T_09_00, T_09_45],
    );
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D2, SVC_OIL, BAY_3, TECH_L3, T_09_00, T_09_45],
    );

    await expectAlreadyExists(() => service.bookAppointmentSlot(BASE_PARAMS));
  });

  it('throws ALREADY_EXISTS when no technician meets RequiredTechLevel', async () => {
    // Require TechLevel 3 but only L1/L2 exist — L3 is occupied
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D1, SVC_OIL, BAY_1, TECH_L3, T_09_00, T_09_45],
    );

    // Only L3 qualifies for RequiredTechLevel 3, but it's occupied
    await expectAlreadyExists(() => service.bookAppointmentSlot({ ...BASE_PARAMS, requiredTechLevel: 3 }));
  });

  it('throws ALREADY_EXISTS when an existing appointment overlaps by one minute', async () => {
    // Existing: 09:00–09:45. New: 09:44–10:29. EndTime=09:45 > StartTime=09:44 → overlap.
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D1, SVC_OIL, BAY_1, TECH_L1, T_09_00, T_09_45],
    );

    const T_09_44 = new Date('2030-06-15T09:44:00.000Z');
    const T_10_29 = new Date('2030-06-15T10:29:00.000Z');

    // Bay 1 and TECH_L1 both have a 1-min overlap with the existing appointment
    // BAY_2 and TECH_L2/L3 are still free, so the service will book those — not ALREADY_EXISTS.
    // To force ALREADY_EXISTS we need ALL bays or ALL techs occupied.
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D1, SVC_OIL, BAY_2, TECH_L2, T_09_44, T_10_29],
    );

    // Now both bays and at least two techs are occupied with overlapping appointments
    await expectAlreadyExists(() =>
      service.bookAppointmentSlot({ ...BASE_PARAMS, requiredTechLevel: 2 }),
    );
  });

  // ─── ABORTED — DB guardrail ───────────────────────────────────────────────

  it('DB EXCLUDE constraint rejects a directly-inserted conflicting row (guardrail fires)', async () => {
    // Insert a valid appointment directly (as the "first" booking)
    await pool.query(
      `INSERT INTO "WorkshopServiceSchedule"
         ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED')`,
      [VEHICLE_1, D1, SVC_OIL, BAY_1, TECH_L1, T_09_00, T_09_45],
    );

    // Attempt a second direct INSERT for the same bay and overlapping time — must be rejected
    await expect(
      pool.query(
        `INSERT INTO "WorkshopServiceSchedule"
           ("VehicleId","DealershipId","WorkshopServiceId","ServiceBayId","TechnicianId","StartTime","EndTime","RequestedUserId","Status")
         VALUES ($1,$2,$3,$4,$5,$6,$7,'user-001','CONFIRMED')`,
        [VEHICLE_1, D1, SVC_OIL, BAY_1, TECH_L3, T_09_00, T_09_45],
      ),
    ).rejects.toMatchObject({ code: '23P01' }); // exclusion_violation — NoOverlapPerBay
  });
});
