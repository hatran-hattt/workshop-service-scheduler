/**
 * Unit tests for CreateAppointmentService
 *
 * validateFormat
 *   Success
 *     - valid request (all fields present and well-formed)
 *   Error — Rule 1: ID fields missing or malformed
 *     - vehicle_id missing
 *     - vehicle_id malformed (not a UUID)
 *     - dealership_id missing
 *     - dealership_id malformed (not a UUID)
 *     - workshop_service_id missing
 *     - workshop_service_id malformed (not a UUID)
 *   Error — Rule 2: start_time missing or invalid
 *     - start_time null
 *     - start_time.seconds is NaN
 *   Error — Rule 3: requested_user_id missing
 *     - requested_user_id missing
 */

import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { CreateAppointmentService } from './create-appointment.service';
import { CreateAppointmentRequest } from '../scheduler.types';

describe('CreateAppointmentService', () => {
  let service: CreateAppointmentService;

  beforeEach(() => {
    service = new CreateAppointmentService();
  });

  describe('validateFormat', () => {
    const valid: CreateAppointmentRequest = {
      vehicle_id: '00000000-0000-0000-0000-000000000001',
      dealership_id: '00000000-0000-0000-0000-000000000002',
      workshop_service_id: '00000000-0000-0000-0000-000000000003',
      start_time: { seconds: 9_999_999_999, nanos: 0 },
      requested_user_id: 'user-abc',
    };

    function expectInvalidArgument(req: CreateAppointmentRequest): void {
      let thrown: unknown;
      try { service.validateFormat(req); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(RpcException);
      expect((thrown as RpcException).getError()).toMatchObject({ code: status.INVALID_ARGUMENT });
    }

    it('passes for a fully valid request', () => {
      expect(() => service.validateFormat(valid)).not.toThrow();
    });

    describe('Rule 1 — vehicle_id, dealership_id, workshop_service_id must be present and valid UUID format', () => {
      it('throws INVALID_ARGUMENT when vehicle_id is missing', () => {
        expectInvalidArgument({ ...valid, vehicle_id: '' });
      });

      it('throws INVALID_ARGUMENT when vehicle_id is malformed', () => {
        expectInvalidArgument({ ...valid, vehicle_id: 'not-a-uuid' });
      });

      it('throws INVALID_ARGUMENT when dealership_id is missing', () => {
        expectInvalidArgument({ ...valid, dealership_id: '' });
      });

      it('throws INVALID_ARGUMENT when dealership_id is malformed', () => {
        expectInvalidArgument({ ...valid, dealership_id: 'not-a-uuid' });
      });

      it('throws INVALID_ARGUMENT when workshop_service_id is missing', () => {
        expectInvalidArgument({ ...valid, workshop_service_id: '' });
      });

      it('throws INVALID_ARGUMENT when workshop_service_id is malformed', () => {
        expectInvalidArgument({ ...valid, workshop_service_id: 'not-a-uuid' });
      });
    });

    describe('Rule 2 — start_time must be present and a valid timestamp', () => {
      it('throws INVALID_ARGUMENT when start_time is null', () => {
        expectInvalidArgument({ ...valid, start_time: null as unknown as CreateAppointmentRequest['start_time'] });
      });

      it('throws INVALID_ARGUMENT when start_time.seconds is NaN', () => {
        expectInvalidArgument({ ...valid, start_time: { seconds: NaN, nanos: 0 } });
      });
    });

    describe('Rule 3 — requested_user_id must be present', () => {
      it('throws INVALID_ARGUMENT when requested_user_id is missing', () => {
        expectInvalidArgument({ ...valid, requested_user_id: '' });
      });
    });
  });
});
