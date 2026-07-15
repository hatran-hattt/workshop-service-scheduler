import { Injectable, Inject } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { Pool } from 'pg';
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

interface BookSlotParams {
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
  validateTimeWindowAndComputeEndTime(
    _startTime: Date,
    _durationMinutes: number,
  ): Date {
    throw new RpcException({ code: status.UNIMPLEMENTED, message: 'stub' });
  }

  /**
   * Atomically books an available ServiceBay and Technician slot.
   * @throws ALREADY_EXISTS (NO_AVAILABILITY) if no ServiceBay or Technician is available for the requested slot.
   * @throws ABORTED if the DB-level EXCLUDE constraint catches a conflict that slipped past the row locks.
   */
  async bookAppointmentSlot(_params: BookSlotParams): Promise<WorkshopServiceScheduleRow> {
    throw new RpcException({ code: status.UNIMPLEMENTED, message: 'stub' });
  }
}

function toDate(ts: { seconds: number; nanos: number }): Date {
  return new Date(ts.seconds * 1000 + Math.floor(ts.nanos / 1_000_000));
}

function fromDate(date: Date): { seconds: number; nanos: number } {
  const ms = date.getTime();
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 };
}

function mapToResponse(row: WorkshopServiceScheduleRow): CreateAppointmentResponse {
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
