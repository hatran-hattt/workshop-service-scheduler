import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import {
  CreateAppointmentRequest,
  CreateAppointmentResponse,
} from '../scheduler.types';

// Internal DB row shapes — PascalCase matches column names per the ERD.
export interface WorkshopServiceRow {
  Id: string;
  Duration: number;          // minutes
  RequiredTechLevel: number;
}

export interface AppointmentRow {
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
  async execute(
    request: CreateAppointmentRequest,
  ): Promise<CreateAppointmentResponse> {
    // see Scheduler Service DD, 3.3
    this.validateFormat(request);
    const workshopService = await this.validateExistenceAndOwnership(request);
    const endTime = this.validateTimeWindowAndComputeEndTime(
      toDate(request.start_time),
      workshopService.Duration,
    );
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

  // see Scheduler Service DD, 3.2, rules 1–3
  validateFormat(request: CreateAppointmentRequest): void {
    throw new RpcException({ code: status.UNIMPLEMENTED, message: 'stub' });
  }

  // see Scheduler Service DD, 3.2, rules 4–7
  async validateExistenceAndOwnership(
    request: CreateAppointmentRequest,
  ): Promise<WorkshopServiceRow> {
    throw new RpcException({ code: status.UNIMPLEMENTED, message: 'stub' });
  }

  // see Scheduler Service DD, 3.3, step 2
  validateTimeWindowAndComputeEndTime(
    startTime: Date,
    durationMinutes: number,
  ): Date {
    throw new RpcException({ code: status.UNIMPLEMENTED, message: 'stub' });
  }

  // see Scheduler Service DD, 3.3, step 3
  async bookAppointmentSlot(params: BookSlotParams): Promise<AppointmentRow> {
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

function mapToResponse(row: AppointmentRow): CreateAppointmentResponse {
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
