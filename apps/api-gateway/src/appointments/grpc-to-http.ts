import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { status as GrpcStatus } from '@grpc/grpc-js';

// 409 error_code values per DD §2.6
export const ERROR_CODE_NO_AVAILABILITY = 'NO_AVAILABILITY';
export const ERROR_CODE_BOOKING_CONFLICT = 'BOOKING_CONFLICT';

interface Timestamp { seconds: number; nanos: number; }

export interface GrpcAppointmentResponse {
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

export interface AppointmentResponseBody {
  appointment_id: string;
  vehicle_id: string;
  dealership_id: string;
  workshop_service_id: string;
  service_bay_id: string;
  technician_id: string;
  start_time: string;
  end_time: string;
  status: string;
  created_at: string;
}

function timestampToIso(ts: Timestamp): string {
  return new Date(ts.seconds * 1000 + Math.floor(ts.nanos / 1_000_000)).toISOString();
}

/** Maps a successful gRPC Appointment response to the REST response body per DD §2.5 and §2.8. */
export function mapGrpcSuccess(grpcResponse: GrpcAppointmentResponse): AppointmentResponseBody {
  const appt = grpcResponse.appointment;
  return {
    appointment_id: appt.id,
    vehicle_id: appt.vehicle_id,
    dealership_id: appt.dealership_id,
    workshop_service_id: appt.workshop_service_id,
    service_bay_id: appt.service_bay_id,
    technician_id: appt.technician_id,
    start_time: timestampToIso(appt.start_time),
    end_time: timestampToIso(appt.end_time),
    // Proto enum value "APPOINTMENT_STATUS_CONFIRMED" → REST value "CONFIRMED"
    status: appt.status.replace('APPOINTMENT_STATUS_', ''),
    created_at: timestampToIso(appt.created_at),
  };
}

/**
 * Maps a gRPC error to an HttpException per the status-code table in DD §2.8.
 * @throws HttpException with the correct HTTP status and body shape.
 */
export function mapGrpcError(err: { code?: number; message?: string }): HttpException {
  const msg = err.message ?? 'Downstream error';

  switch (err.code) {
    case GrpcStatus.INVALID_ARGUMENT:
      return new BadRequestException(msg);
    case GrpcStatus.UNAUTHENTICATED:
      return new UnauthorizedException(msg);
    case GrpcStatus.PERMISSION_DENIED:
      return new ForbiddenException(msg);
    case GrpcStatus.NOT_FOUND:
      return new NotFoundException(msg);
    // Two distinct 409 cases — error_code in body distinguishes them (DD §2.6)
    case GrpcStatus.ALREADY_EXISTS:
      return new HttpException(
        { error_code: ERROR_CODE_NO_AVAILABILITY, message: msg },
        HttpStatus.CONFLICT,
      );
    case GrpcStatus.ABORTED:
      return new HttpException(
        { error_code: ERROR_CODE_BOOKING_CONFLICT, message: msg },
        HttpStatus.CONFLICT,
      );
    case GrpcStatus.RESOURCE_EXHAUSTED:
      return new HttpException(msg, HttpStatus.TOO_MANY_REQUESTS);
    case GrpcStatus.UNAVAILABLE:
      return new HttpException(msg, HttpStatus.SERVICE_UNAVAILABLE);
    case GrpcStatus.DEADLINE_EXCEEDED:
      return new HttpException(msg, HttpStatus.GATEWAY_TIMEOUT);
    default:
      return new InternalServerErrorException(msg);
  }
}
