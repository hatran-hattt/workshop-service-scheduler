import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  OnModuleInit,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Request } from 'express';
import { firstValueFrom, timeout } from 'rxjs';
import { JwtGuard } from '../auth/jwt.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { validateRequestFormat } from './format-validation';
import { mapGrpcSuccess, mapGrpcError, GrpcAppointmentResponse } from './grpc-to-http';

const GRPC_TIMEOUT_MS = 5_000; // 5 s per DD §2.7

// Proto contract types — snake_case matches proto field names (keepCase: true in loader).
// Timestamp.seconds is number via longs:Number loader option.
interface Timestamp { seconds: number; nanos: number; }

interface CreateAppointmentRequest {
  vehicle_id: string;
  dealership_id: string;
  workshop_service_id: string;
  start_time: Timestamp;
  requested_user_id: string;
}

interface SchedulerServiceGrpcClient {
  createAppointment(data: CreateAppointmentRequest): import('rxjs').Observable<GrpcAppointmentResponse>;
}

function isoToTimestamp(iso: string): Timestamp {
  const ms = new Date(iso).getTime();
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 };
}

type AuthedRequest = Request & { userId: string };

@Controller('api/v1/ownership')
@UseGuards(JwtGuard, RateLimitGuard)
export class AppointmentsController implements OnModuleInit {
  private schedulerService!: SchedulerServiceGrpcClient;

  constructor(
    @Inject('SCHEDULER_SERVICE') private readonly client: ClientGrpc,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.schedulerService =
      this.client.getService<SchedulerServiceGrpcClient>('SchedulerService');
  }

  /**
   * POST /api/v1/ownership/appointments
   * Full pipeline per DD §2.7: auth → rate-limit → format-validate → idempotency → gRPC → cache → 201.
   * @throws 400 if headers/body format is invalid or Idempotency-Key is reused with a different body
   * @throws 401 if the JWT is missing or invalid
   * @throws 403 if the authenticated user does not own the vehicle
   * @throws 404 if any referenced entity does not exist
   * @throws 409 NO_AVAILABILITY if no matching service bay / technician slot exists
   * @throws 409 BOOKING_CONFLICT if a concurrent request won the same slot
   * @throws 429 if the user exceeds 10 requests per minute
   * @throws 503 if the Scheduler Service is unreachable
   * @throws 504 if the Scheduler Service call times out
   */
  @Post('appointments')
  @HttpCode(HttpStatus.CREATED)
  async createAppointment(
    @Req() req: AuthedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Body() body: {
      vehicle_id?: string;
      dealership_id?: string;
      workshop_service_id?: string;
      start_time?: string;
    },
  ): Promise<unknown> {
    // Step 1 — userId extracted from validated JWT by JwtGuard
    const userId = req.userId;

    // Step 2 — validate headers and body format (throws 400 on failure)
    validateRequestFormat({ idempotencyKey, contentType }, body);

    // Step 3 — idempotency check (throws 400 on key reuse with different body)
    const bodyHash = this.idempotency.hashBody(body as Required<typeof body>);
    const cached = await this.idempotency.check(userId, idempotencyKey!, bodyHash);
    if (cached) return cached;

    // Step 4 — call Scheduler Service with 5-second timeout
    let grpcResponse: GrpcAppointmentResponse;
    try {
      grpcResponse = await firstValueFrom(
        this.schedulerService
          .createAppointment({
            vehicle_id: body.vehicle_id!,
            dealership_id: body.dealership_id!,
            workshop_service_id: body.workshop_service_id!,
            start_time: isoToTimestamp(body.start_time!),
            requested_user_id: userId,
          })
          .pipe(timeout(GRPC_TIMEOUT_MS)),
      );
    } catch (err) {
      throw mapGrpcError(err as { code?: number; message?: string });
    }

    // Step 5 — map gRPC response to REST body and cache for idempotent replays
    const responseBody = mapGrpcSuccess(grpcResponse);
    await this.idempotency.cache(
      userId,
      idempotencyKey!,
      bodyHash,
      responseBody as unknown as Record<string, unknown>,
    );

    return responseBody;
  }
}
