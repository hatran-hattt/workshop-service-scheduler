import { Injectable, Inject } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { Pool, PoolClient } from 'pg';
import {
  CreateAppointmentRequest,
  CreateAppointmentResponse,
} from '../scheduler.types';

export const PG_POOL = 'PG_POOL';

// Represents a row from the WorkshopService table. PascalCase matches DB column names per the ERD.
export interface WorkshopServiceRow {
  Id: string;
  Duration: number;          // minutes
  RequiredTechLevel: number;
}

// Represents a row from the WorkshopServiceSchedule table. PascalCase matches DB column names per the ERD.
export interface WorkshopServiceScheduleRow {
  Id: string;
  WorkshopServiceId: string;
  DealershipId: string;
  ServiceBayId: string;
  TechnicianId: string;
  VehicleId: string;
  StartTime: Date;
  EndTime: Date;
  RequestedUserId: string;
  Status: string;
  CreatedAt: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET']);

const SLOT_MINUTES = 15;
const BOOKING_BUFFER_MINUTES = 15;
const BOOKING_HORIZON_DAYS = 30;
const BUSINESS_OPEN_HOUR = 9;
const BUSINESS_CLOSE_HOUR = 18;
const LUNCH_START_HOUR = 12;
const LUNCH_END_HOUR = 13;
const LUNCH_DURATION_MINUTES = 60;

export interface BookSlotParams {
  vehicleId: string;
  dealershipId: string;
  workshopServiceId: string;
  startTime: Date;
  endTime: Date;
  requiredTechLevel: number;
  requestedUserId: string;
}

@Injectable()
export class CreateAppointmentService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  /** Orchestrates the full CreateAppointment flow. */
  async execute(
    request: CreateAppointmentRequest,
  ): Promise<CreateAppointmentResponse> {
    // Step 1a — validate format (rules 1–3)
    this.validateFormat(request);

    // Step 1b — validate existence and ownership (rules 4–7);
    // WorkshopService row carries Duration and RequiredTechLevel for steps 2–3
    const workshopService = await this.validateExistenceAndOwnership(request);

    // Step 2 — validate start_time window rules (rules 8–11) and compute end_time (rule 12)
    const endTime = this.validateTimeWindowAndComputeEndTime(
      toDate(request.start_time),
      workshopService.Duration,
    );

    // Step 3 — open transaction: lock a candidate ServiceBay, lock a candidate Technician,
    // insert WorkshopServiceSchedule row
    const row = await this.bookAppointmentSlot({
      vehicleId: request.vehicle_id,
      dealershipId: request.dealership_id,
      workshopServiceId: request.workshop_service_id,
      startTime: toDate(request.start_time),
      endTime,
      requiredTechLevel: workshopService.RequiredTechLevel,
      requestedUserId: request.requested_user_id,
    });

    return mapToResponse(row);
  }

  /**
   * Validates format of all request fields.
   * @throws INVALID_ARGUMENT if any field is missing or malformed.
   */
  validateFormat(request: CreateAppointmentRequest): void {
    // Rule 1 — vehicle_id, dealership_id, workshop_service_id must be present and valid UUID format
    for (const [field, value] of [
      ['vehicle_id', request.vehicle_id],
      ['dealership_id', request.dealership_id],
      ['workshop_service_id', request.workshop_service_id],
    ] as [string, string][]) {
      if (!value || !UUID_RE.test(value)) {
        throw new RpcException({
          code: status.INVALID_ARGUMENT,
          message: `${field} must be a valid UUID`,
        });
      }
    }

    // Rule 2 — start_time must be present and a valid timestamp
    if (!request.start_time || !isFinite(request.start_time.seconds)) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'start_time must be present and a valid timestamp',
      });
    }

    // Rule 3 — requested_user_id must be present
    if (!request.requested_user_id) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'requested_user_id must be present',
      });
    }
  }

  /**
   * Validates existence and ownership. Returns the WorkshopService
   * row — Duration and RequiredTechLevel are needed for subsequent steps.
   * @throws NOT_FOUND if vehicle_id, dealership_id, or workshop_service_id doesn't exist or IsActive = false.
   * @throws PERMISSION_DENIED if vehicle_id does not belong to requested_user_id.
   */
  async validateExistenceAndOwnership(
    request: CreateAppointmentRequest,
  ): Promise<WorkshopServiceRow> {
    // Rule 4 & 5 — vehicle_id must exist in Vehicle; CustomerId must match requested_user_id
    const vehicleResult = await this.pool.query<{ CustomerId: string }>(
      'SELECT "CustomerId" FROM "Vehicle" WHERE "Id" = $1',
      [request.vehicle_id],
    );
    if (vehicleResult.rows.length === 0) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'vehicle_id not found' });
    }
    if (vehicleResult.rows[0].CustomerId !== request.requested_user_id) {
      throw new RpcException({ code: status.PERMISSION_DENIED, message: 'vehicle_id does not belong to requested_user_id' });
    }

    // Rule 6 — dealership_id must exist in Dealership, IsActive = true
    const dealershipResult = await this.pool.query<{ Id: string }>(
      'SELECT "Id" FROM "Dealership" WHERE "Id" = $1 AND "IsActive" = true',
      [request.dealership_id],
    );
    if (dealershipResult.rows.length === 0) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'dealership_id not found or inactive' });
    }

    // Rule 7 — workshop_service_id must exist in WorkshopService, IsActive = true; returns Duration and RequiredTechLevel
    const serviceResult = await this.pool.query<WorkshopServiceRow>(
      'SELECT "Id", "Duration", "RequiredTechLevel" FROM "WorkshopService" WHERE "Id" = $1 AND "IsActive" = true',
      [request.workshop_service_id],
    );
    if (serviceResult.rows.length === 0) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'workshop_service_id not found or inactive' });
    }

    return serviceResult.rows[0];
  }

  /**
   * Validates start_time window rules and computes end_time.
   * @throws INVALID_ARGUMENT if any window rule fails.
   */
  validateTimeWindowAndComputeEndTime(startTime: Date, durationMinutes: number): Date {
    const now = new Date();

    // Rule 8 — start_time must align to a 15-minute slot boundary
    if (startTime.getUTCMinutes() % SLOT_MINUTES !== 0 || startTime.getUTCSeconds() !== 0 || startTime.getUTCMilliseconds() !== 0) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'start_time must align to a 15-minute slot boundary' });
    }

    // Rule 9 — start_time must be > 15 minutes from current time
    if (startTime.getTime() <= now.getTime() + BOOKING_BUFFER_MINUTES * 60 * 1000) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'start_time must be more than 15 minutes from now' });
    }

    // Rule 10 — start_time must fall within a date ≤ 30 days from today
    const todayUtc = new Date(now);
    todayUtc.setUTCHours(0, 0, 0, 0);
    const horizonDate = new Date(todayUtc.getTime() + BOOKING_HORIZON_DAYS * 24 * 60 * 60 * 1000);
    const startDateUtc = new Date(startTime);
    startDateUtc.setUTCHours(0, 0, 0, 0);
    if (startDateUtc > horizonDate) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'start_time must be within 30 days from today' });
    }

    // Rule 11 — start_time must not fall within the lunch break (12:00–13:00)
    const startHour = startTime.getUTCHours();
    if (startHour >= LUNCH_START_HOUR && startHour < LUNCH_END_HOUR) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'start_time must not fall within the lunch break (12:00–13:00)' });
    }

    // Rule 12 — the [start_time, end_time] range must fall within business hours (09:00–18:00).
    // Reject if start_time itself is before business open (09:00).
    const openingTime = new Date(startTime);
    openingTime.setUTCHours(BUSINESS_OPEN_HOUR, 0, 0, 0);
    if (startTime < openingTime) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'start_time must be within business hours (09:00–18:00)' });
    }

    // Compute end_time; extend by LUNCH_DURATION_MINUTES if the appointment spans into the lunch
    // break (start before 12:00 and raw end strictly after 12:00 — raw end at 12:00 exactly does
    // not trigger extension). Reject if the final end_time exceeds business close (18:00).
    const rawEnd = new Date(startTime.getTime() + durationMinutes * 60 * 1000);
    const lunchStart = new Date(startTime);
    lunchStart.setUTCHours(LUNCH_START_HOUR, 0, 0, 0);
    const spansLunch = startTime < lunchStart && rawEnd > lunchStart;
    const endTime = spansLunch
      ? new Date(rawEnd.getTime() + LUNCH_DURATION_MINUTES * 60 * 1000)
      : rawEnd;

    const closingTime = new Date(startTime);
    closingTime.setUTCHours(BUSINESS_CLOSE_HOUR, 0, 0, 0);
    if (endTime > closingTime) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'computed end_time exceeds business hours (18:00)' });
    }

    return endTime;
  }

  /**
   * Atomically books an available ServiceBay and Technician slot.
   * @throws ALREADY_EXISTS (NO_AVAILABILITY) if no ServiceBay or Technician is available for the requested slot.
   * @throws ABORTED if the DB-level EXCLUDE constraint catches a conflict that slipped past the row locks.
   */
  async bookAppointmentSlot(params: BookSlotParams): Promise<WorkshopServiceScheduleRow> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');

      // Lock a candidate ServiceBay — NOT EXISTS overlap check uses half-open interval
      // (StartTime < end AND EndTime > start), so two appointments that exactly touch do not conflict.
      // NOT EXISTS is used rather than NOT IN because NOT IN behaves unexpectedly when the subquery returns NULLs.
      const bayResult = await client.query<{ Id: string }>(
        `SELECT "Id" FROM "ServiceBay" sb
         WHERE sb."DealershipId" = $1
           AND sb."IsActive" = true
           AND NOT EXISTS (
             SELECT 1 FROM "WorkshopServiceSchedule" wss
             WHERE wss."ServiceBayId" = sb."Id"
               AND wss."StartTime" < $3 AND wss."EndTime" > $2
           )
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [params.dealershipId, params.startTime, params.endTime],
      );
      if (bayResult.rows.length === 0) {
        throw new RpcException({ code: status.ALREADY_EXISTS, message: 'NO_AVAILABILITY: no service bay available' });
      }
      const bayId = bayResult.rows[0].Id;

      // Lock a candidate Technician — same overlap pattern, additionally filtered by TechLevel
      const techResult = await client.query<{ Id: string }>(
        `SELECT "Id" FROM "Technician" t
         WHERE t."DealershipId" = $1
           AND t."IsActive" = true
           AND t."TechLevel" >= $4
           AND NOT EXISTS (
             SELECT 1 FROM "WorkshopServiceSchedule" wss
             WHERE wss."TechnicianId" = t."Id"
               AND wss."StartTime" < $3 AND wss."EndTime" > $2
           )
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [params.dealershipId, params.startTime, params.endTime, params.requiredTechLevel],
      );
      if (techResult.rows.length === 0) {
        throw new RpcException({ code: status.ALREADY_EXISTS, message: 'NO_AVAILABILITY: no technician available' });
      }
      const technicianId = techResult.rows[0].Id;

      // Insert the WorkshopServiceSchedule row; Id and CreatedAt are DB-generated
      const insertResult = await client.query<WorkshopServiceScheduleRow>(
        `INSERT INTO "WorkshopServiceSchedule" (
           "VehicleId", "DealershipId", "WorkshopServiceId", "ServiceBayId", "TechnicianId",
           "StartTime", "EndTime", "RequestedUserId", "Status"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CONFIRMED')
         RETURNING *`,
        [
          params.vehicleId,
          params.dealershipId,
          params.workshopServiceId,
          bayId,
          technicianId,
          params.startTime,
          params.endTime,
          params.requestedUserId,
        ],
      );

      await client.query('COMMIT');
      return insertResult.rows[0];

    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});

      if (err instanceof RpcException) throw err;

      // EXCLUDE constraint violation — a conflicting row slipped past the app-level locks
      if ((err as { code?: string }).code === '23P01') {
        throw new RpcException({ code: status.ABORTED, message: 'booking conflict caught by DB EXCLUDE constraint' });
      }

      // Node-level network errors mean the data layer is unreachable — retryable by the gateway
      if (NETWORK_ERROR_CODES.has((err as { code?: string }).code ?? '')) {
        throw new RpcException({ code: status.UNAVAILABLE, message: 'database unavailable' });
      }

      throw new RpcException({ code: status.INTERNAL, message: 'unexpected database error' });
    } finally {
      client?.release();
    }
  }
}

function toDate(ts: { seconds: number; nanos: number }): Date {
  return new Date(ts.seconds * 1000 + Math.floor(ts.nanos / 1_000_000));
}

function fromDate(date: Date): { seconds: number; nanos: number } {
  const ms = date.getTime();
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 };
}

export function mapToResponse(row: WorkshopServiceScheduleRow): CreateAppointmentResponse {
  return {
    appointment: {
      id: row.Id,
      vehicle_id: row.VehicleId,
      dealership_id: row.DealershipId,
      workshop_service_id: row.WorkshopServiceId,
      service_bay_id: row.ServiceBayId,
      technician_id: row.TechnicianId,
      start_time: fromDate(row.StartTime),
      end_time: fromDate(row.EndTime),
      status: 'APPOINTMENT_STATUS_CONFIRMED',
      created_at: fromDate(row.CreatedAt),
    },
  };
}
