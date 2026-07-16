/**
 * Unit tests for gRPC → HTTP mapping [U]
 *
 * mapGrpcSuccess
 *   Success
 *     - maps all appointment fields correctly
 *     - converts proto Timestamp to ISO 8601 string
 *     - strips APPOINTMENT_STATUS_ prefix from status enum
 *
 * mapGrpcError
 *   INVALID_ARGUMENT → 400 BadRequestException
 *   UNAUTHENTICATED  → 401 UnauthorizedException
 *   PERMISSION_DENIED → 403 ForbiddenException
 *   NOT_FOUND        → 404 NotFoundException
 *   ALREADY_EXISTS   → 409 with error_code NO_AVAILABILITY
 *   ABORTED          → 409 with error_code BOOKING_CONFLICT
 *   RESOURCE_EXHAUSTED → 429
 *   UNAVAILABLE      → 503
 *   DEADLINE_EXCEEDED → 504
 *   INTERNAL (and any unknown code) → 500
 */

import { HttpStatus } from '@nestjs/common';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  mapGrpcSuccess,
  mapGrpcError,
  GrpcAppointmentResponse,
  ERROR_CODE_NO_AVAILABILITY,
  ERROR_CODE_BOOKING_CONFLICT,
} from './grpc-to-http';

function makeTimestamp(isoString: string): { seconds: number; nanos: number } {
  const ms = new Date(isoString).getTime();
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 };
}

const GRPC_RESPONSE: GrpcAppointmentResponse = {
  appointment: {
    id: 'appt-uuid-001',
    vehicle_id: 'veh-uuid-001',
    dealership_id: 'dlr-uuid-001',
    workshop_service_id: 'ws-uuid-001',
    service_bay_id: 'bay-uuid-001',
    technician_id: 'tech-uuid-001',
    start_time: makeTimestamp('2030-06-15T09:00:00.000Z'),
    end_time: makeTimestamp('2030-06-15T10:30:00.000Z'),
    status: 'APPOINTMENT_STATUS_CONFIRMED',
    created_at: makeTimestamp('2030-06-01T08:00:00.000Z'),
  },
};

// ─── mapGrpcSuccess ────────────────────────────────────────────────────────────

describe('mapGrpcSuccess', () => {
  it('maps all appointment fields correctly', () => {
    const body = mapGrpcSuccess(GRPC_RESPONSE);
    expect(body.appointment_id).toBe('appt-uuid-001');
    expect(body.vehicle_id).toBe('veh-uuid-001');
    expect(body.dealership_id).toBe('dlr-uuid-001');
    expect(body.workshop_service_id).toBe('ws-uuid-001');
    expect(body.service_bay_id).toBe('bay-uuid-001');
    expect(body.technician_id).toBe('tech-uuid-001');
  });

  it('converts proto Timestamps to ISO 8601 strings', () => {
    const body = mapGrpcSuccess(GRPC_RESPONSE);
    expect(body.start_time).toBe('2030-06-15T09:00:00.000Z');
    expect(body.end_time).toBe('2030-06-15T10:30:00.000Z');
    expect(body.created_at).toBe('2030-06-01T08:00:00.000Z');
  });

  it('strips APPOINTMENT_STATUS_ prefix from the status enum', () => {
    const body = mapGrpcSuccess(GRPC_RESPONSE);
    expect(body.status).toBe('CONFIRMED');
  });
});

// ─── mapGrpcError ──────────────────────────────────────────────────────────────

describe('mapGrpcError', () => {
  it('maps INVALID_ARGUMENT to 400', () => {
    const ex = mapGrpcError({ code: GrpcStatus.INVALID_ARGUMENT, message: 'bad' });
    expect(ex.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('maps UNAUTHENTICATED to 401', () => {
    const ex = mapGrpcError({ code: GrpcStatus.UNAUTHENTICATED, message: 'unauth' });
    expect(ex.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('maps PERMISSION_DENIED to 403', () => {
    const ex = mapGrpcError({ code: GrpcStatus.PERMISSION_DENIED, message: 'denied' });
    expect(ex.getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('maps NOT_FOUND to 404', () => {
    const ex = mapGrpcError({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    expect(ex.getStatus()).toBe(HttpStatus.NOT_FOUND);
  });

  it('maps ALREADY_EXISTS to 409 with error_code NO_AVAILABILITY', () => {
    const ex = mapGrpcError({ code: GrpcStatus.ALREADY_EXISTS, message: 'no slots' });
    expect(ex.getStatus()).toBe(HttpStatus.CONFLICT);
    expect((ex.getResponse() as Record<string, unknown>).error_code).toBe(ERROR_CODE_NO_AVAILABILITY);
  });

  it('maps ABORTED to 409 with error_code BOOKING_CONFLICT', () => {
    const ex = mapGrpcError({ code: GrpcStatus.ABORTED, message: 'conflict' });
    expect(ex.getStatus()).toBe(HttpStatus.CONFLICT);
    expect((ex.getResponse() as Record<string, unknown>).error_code).toBe(ERROR_CODE_BOOKING_CONFLICT);
  });

  it('maps RESOURCE_EXHAUSTED to 429', () => {
    const ex = mapGrpcError({ code: GrpcStatus.RESOURCE_EXHAUSTED, message: 'rate limited' });
    expect(ex.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('maps UNAVAILABLE to 503', () => {
    const ex = mapGrpcError({ code: GrpcStatus.UNAVAILABLE, message: 'down' });
    expect(ex.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('maps DEADLINE_EXCEEDED to 504', () => {
    const ex = mapGrpcError({ code: GrpcStatus.DEADLINE_EXCEEDED, message: 'timeout' });
    expect(ex.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
  });

  it('maps INTERNAL (and any unknown code) to 500', () => {
    const exInternal = mapGrpcError({ code: GrpcStatus.INTERNAL, message: 'oops' });
    expect(exInternal.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);

    const exUnknown = mapGrpcError({ code: 9999, message: 'unknown' });
    expect(exUnknown.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });
});
