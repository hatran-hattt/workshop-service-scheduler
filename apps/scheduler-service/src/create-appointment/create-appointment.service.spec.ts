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
 *
 * validateExistenceAndOwnership
 *   Success
 *     - all entities exist, active, and vehicle belongs to requesting user
 *   Error — Rule 4: vehicle not found
 *     - vehicle_id not found in Vehicle table
 *   Error — Rule 5: vehicle ownership mismatch
 *     - vehicle found but CustomerId does not match requested_user_id
 *   Error — Rule 6: dealership not found or inactive
 *     - dealership_id not found in Dealership table
 *     - dealership exists but IsActive = false
 *   Error — Rule 7: workshop service not found or inactive
 *
 * validateTimeWindowAndComputeEndTime
 *   Success
 *     - valid mid-morning slot, no lunch overlap
 *     - raw end_time exactly at 12:00 (no lunch extension)
 *     - raw end spans lunch, extension lands exactly at 18:00 (boundary — passes)
 *     - start in afternoon session (no lunch adjustment)
 *   Error — Rule 8: start_time not on 15-minute slot boundary
 *     - start_time minutes not divisible by 15
 *   Error — Rule 9: start_time too close to now
 *     - start_time exactly 15 minutes from now (boundary — fails, must be strictly >)
 *     - start_time less than 15 minutes from now
 *   Error — Rule 10: start_time beyond 30-day booking horizon
 *     - start_time exactly 30 days from today (boundary — passes)
 *     - start_time 30 days + 1 day from today (fails)
 *   Error — Rule 11: start_time in lunch break
 *     - start_time at 12:00
 *     - start_time at 12:30
 *   Error — Rule 12: start_time or computed end_time outside business hours (09:00–18:00)
 *     - start_time before business open (08:45, fails)
 *     - start_time exactly at business open (09:00, boundary — passes)
 *     - raw end spans lunch, extension pushes end_time to 18:01 (fails)
 *     - workshop_service_id not found in WorkshopService table
 *     - workshop service exists but IsActive = false
 */

import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { CreateAppointmentService } from './create-appointment.service';
import { CreateAppointmentRequest } from '../scheduler.types';

describe('CreateAppointmentService', () => {
  let service: CreateAppointmentService;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    service = new CreateAppointmentService(mockPool as any);
  });

  // ─── validateFormat ────────────────────────────────────────────────────────

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

  // ─── validateExistenceAndOwnership ────────────────────────────────────────

  describe('validateExistenceAndOwnership', () => {
    const valid: CreateAppointmentRequest = {
      vehicle_id: '00000000-0000-0000-0000-000000000001',
      dealership_id: '00000000-0000-0000-0000-000000000002',
      workshop_service_id: '00000000-0000-0000-0000-000000000003',
      start_time: { seconds: 9_999_999_999, nanos: 0 },
      requested_user_id: 'user-abc',
    };

    const vehicleRow = { rows: [{ CustomerId: 'user-abc' }] };
    const dealershipRow = { rows: [{ Id: '00000000-0000-0000-0000-000000000002' }] };
    const serviceRow = { rows: [{ Id: '00000000-0000-0000-0000-000000000003', Duration: 60, RequiredTechLevel: 2 }] };
    const emptyResult = { rows: [] };

    function expectError(code: number): (req: CreateAppointmentRequest) => Promise<void> {
      return async (req) => {
        let thrown: unknown;
        try { await service.validateExistenceAndOwnership(req); } catch (e) { thrown = e; }
        expect(thrown).toBeInstanceOf(RpcException);
        expect((thrown as RpcException).getError()).toMatchObject({ code });
      };
    }

    it('returns WorkshopService row when all entities exist and are valid', async () => {
      mockPool.query
        .mockResolvedValueOnce(vehicleRow)
        .mockResolvedValueOnce(dealershipRow)
        .mockResolvedValueOnce(serviceRow);

      const result = await service.validateExistenceAndOwnership(valid);
      expect(result).toMatchObject({ Id: '00000000-0000-0000-0000-000000000003', Duration: 60, RequiredTechLevel: 2 });
    });

    describe('Rule 4 — vehicle_id must exist in Vehicle', () => {
      it('throws NOT_FOUND when vehicle_id not found', async () => {
        mockPool.query.mockResolvedValueOnce(emptyResult);
        await expectError(status.NOT_FOUND)(valid);
      });
    });

    describe('Rule 5 — vehicle_id must belong to requested_user_id', () => {
      it('throws PERMISSION_DENIED when vehicle belongs to a different user', async () => {
        mockPool.query.mockResolvedValueOnce({ rows: [{ CustomerId: 'other-user' }] });
        await expectError(status.PERMISSION_DENIED)(valid);
      });
    });

    describe('Rule 6 — dealership_id must exist in Dealership, IsActive = true', () => {
      it('throws NOT_FOUND when dealership_id not found', async () => {
        mockPool.query
          .mockResolvedValueOnce(vehicleRow)
          .mockResolvedValueOnce(emptyResult);
        await expectError(status.NOT_FOUND)(valid);
      });

      it('throws NOT_FOUND when dealership exists but IsActive = false', async () => {
        mockPool.query
          .mockResolvedValueOnce(vehicleRow)
          .mockResolvedValueOnce(emptyResult); // IsActive=false filtered out by WHERE clause
        await expectError(status.NOT_FOUND)(valid);
      });
    });

    describe('Rule 7 — workshop_service_id must exist in WorkshopService, IsActive = true', () => {
      it('throws NOT_FOUND when workshop_service_id not found', async () => {
        mockPool.query
          .mockResolvedValueOnce(vehicleRow)
          .mockResolvedValueOnce(dealershipRow)
          .mockResolvedValueOnce(emptyResult);
        await expectError(status.NOT_FOUND)(valid);
      });

      it('throws NOT_FOUND when workshop service exists but IsActive = false', async () => {
        mockPool.query
          .mockResolvedValueOnce(vehicleRow)
          .mockResolvedValueOnce(dealershipRow)
          .mockResolvedValueOnce(emptyResult); // IsActive=false filtered out by WHERE clause
        await expectError(status.NOT_FOUND)(valid);
      });
    });
  });

  // ─── validateTimeWindowAndComputeEndTime ──────────────────────────────────

  describe('validateTimeWindowAndComputeEndTime', () => {
    // Fixed "now" well before the test dates so all 2024-01-15 slots are safely in the future.
    // Rule 9 tests override this per-case to place "now" close to the slot under test.
    const BASE_NOW = new Date('2024-01-14T08:00:00.000Z');

    beforeAll(() => { jest.useFakeTimers(); });
    afterAll(() => { jest.useRealTimers(); });
    beforeEach(() => { jest.setSystemTime(BASE_NOW); });

    function expectInvalidArgument(startTime: Date, duration: number): void {
      let thrown: unknown;
      try { service.validateTimeWindowAndComputeEndTime(startTime, duration); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(RpcException);
      expect((thrown as RpcException).getError()).toMatchObject({ code: status.INVALID_ARGUMENT });
    }

    it('valid mid-morning slot, no lunch overlap', () => {
      const start = new Date('2024-01-15T09:00:00.000Z');
      const end = service.validateTimeWindowAndComputeEndTime(start, 60);
      expect(end).toEqual(new Date('2024-01-15T10:00:00.000Z'));
    });

    it('raw end_time exactly at 12:00 does not trigger lunch extension', () => {
      // start 09:00 + 180 min = 12:00 exactly; 12:00 > lunchStart(12:00) is false → no extension
      const start = new Date('2024-01-15T09:00:00.000Z');
      const end = service.validateTimeWindowAndComputeEndTime(start, 180);
      expect(end).toEqual(new Date('2024-01-15T12:00:00.000Z'));
    });

    it('raw end spans lunch, extension lands exactly at 18:00 (boundary — passes)', () => {
      // start 09:00 + 480 min = 17:00 raw; 17:00 > 12:00 → extend +60 → 18:00 ≤ 18:00 → passes
      const start = new Date('2024-01-15T09:00:00.000Z');
      const end = service.validateTimeWindowAndComputeEndTime(start, 480);
      expect(end).toEqual(new Date('2024-01-15T18:00:00.000Z'));
    });

    it('start in afternoon session — no lunch adjustment applied', () => {
      // start 13:00 is not < lunchStart(12:00) → spansLunch = false → no extension
      const start = new Date('2024-01-15T13:00:00.000Z');
      const end = service.validateTimeWindowAndComputeEndTime(start, 60);
      expect(end).toEqual(new Date('2024-01-15T14:00:00.000Z'));
    });

    describe('Rule 8 — start_time must align to a 15-minute slot boundary', () => {
      it('throws INVALID_ARGUMENT when start_time minutes are not divisible by 15', () => {
        expectInvalidArgument(new Date('2024-01-15T09:10:00.000Z'), 60);
      });
    });

    describe('Rule 9 — start_time must be > 15 minutes from current time', () => {
      it('throws INVALID_ARGUMENT when start_time is exactly 15 minutes from now (boundary — strictly > required)', () => {
        jest.setSystemTime(new Date('2024-01-15T09:00:00.000Z'));
        expectInvalidArgument(new Date('2024-01-15T09:15:00.000Z'), 60);
      });

      it('throws INVALID_ARGUMENT when start_time is less than 15 minutes from now', () => {
        jest.setSystemTime(new Date('2024-01-15T09:01:00.000Z')); // 09:15 is only 14 min away
        expectInvalidArgument(new Date('2024-01-15T09:15:00.000Z'), 60);
      });
    });

    describe('Rule 10 — start_time must be within 30 days from today', () => {
      it('passes when start_time is exactly 30 days from today (boundary)', () => {
        // today (00:00 UTC) 2024-01-14 + 30 days = 2024-02-13
        jest.setSystemTime(new Date('2024-01-14T08:00:00.000Z'));
        const start = new Date('2024-02-13T09:00:00.000Z');
        expect(() => service.validateTimeWindowAndComputeEndTime(start, 60)).not.toThrow();
      });

      it('throws INVALID_ARGUMENT when start_time is 30 days + 1 day from today', () => {
        jest.setSystemTime(new Date('2024-01-14T08:00:00.000Z'));
        expectInvalidArgument(new Date('2024-02-14T09:00:00.000Z'), 60);
      });
    });

    describe('Rule 11 — start_time must not fall within the lunch break (12:00–13:00)', () => {
      it('throws INVALID_ARGUMENT when start_time is at 12:00', () => {
        expectInvalidArgument(new Date('2024-01-15T12:00:00.000Z'), 60);
      });

      it('throws INVALID_ARGUMENT when start_time is at 12:30', () => {
        expectInvalidArgument(new Date('2024-01-15T12:30:00.000Z'), 60);
      });
    });

    describe('Rule 12 — start_time or computed end_time outside business hours (09:00–18:00)', () => {
      it('throws INVALID_ARGUMENT when start_time is before business open (08:45)', () => {
        expectInvalidArgument(new Date('2024-01-15T08:45:00.000Z'), 60);
      });

      it('passes when start_time is exactly business open (09:00, boundary)', () => {
        const start = new Date('2024-01-15T09:00:00.000Z');
        expect(() => service.validateTimeWindowAndComputeEndTime(start, 60)).not.toThrow();
      });

      it('throws INVALID_ARGUMENT when extension pushes end_time to 18:01', () => {
        // start 09:00 + 481 min = 17:01 raw; 17:01 > 12:00 → extend +60 → 18:01 > 18:00 → fails
        expectInvalidArgument(new Date('2024-01-15T09:00:00.000Z'), 481);
      });
    });
  });
});
