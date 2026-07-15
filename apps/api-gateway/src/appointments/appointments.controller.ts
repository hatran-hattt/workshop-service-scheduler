import { Body, Controller, Inject, OnModuleInit, Post } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable } from 'rxjs';

// Proto contract types — snake_case matches proto field names.
// Timestamp.seconds is number via longs:Number loader option.
interface Timestamp {
  seconds: number;
  nanos: number;
}

interface CreateAppointmentRequest {
  vehicle_id: string;
  dealership_id: string;
  workshop_service_id: string;
  start_time: Timestamp;
  requested_user_id: string;
}

interface CreateAppointmentResponse {
  appointment: {
    id: string;
    vehicle_id: string;
    dealership_id: string;
    workshop_service_id: string;
    service_bay_id: string;
    technician_id: string;
    start_time: Timestamp;
    end_time: Timestamp;
    status: string;
    created_at: Timestamp;
  };
}

interface SchedulerServiceGrpcClient {
  createAppointment(
    data: CreateAppointmentRequest,
  ): Observable<CreateAppointmentResponse>;
}

// Phase 2 stub: accepts the real request shape and forwards to gRPC.
// Auth, validation, idempotency, and response mapping are added in Phase 3.
@Controller('api/v1/ownership')
export class AppointmentsController implements OnModuleInit {
  private schedulerService!: SchedulerServiceGrpcClient;

  constructor(@Inject('SCHEDULER_SERVICE') private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.schedulerService =
      this.client.getService<SchedulerServiceGrpcClient>('SchedulerService');
  }

  @Post('appointments')
  createAppointment(
    @Body() body: {
      vehicle_id: string;
      dealership_id: string;
      workshop_service_id: string;
      start_time: string;  // ISO 8601 — converted to Timestamp below
    },
  ): Observable<CreateAppointmentResponse> {
    return this.schedulerService.createAppointment({
      vehicle_id: body.vehicle_id,
      dealership_id: body.dealership_id,
      workshop_service_id: body.workshop_service_id,
      start_time: isoToTimestamp(body.start_time),
      requested_user_id: 'stub-user', // Phase 3: extracted from validated JWT
    });
  }
}

function isoToTimestamp(iso: string): Timestamp {
  const ms = new Date(iso).getTime();
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 };
}
