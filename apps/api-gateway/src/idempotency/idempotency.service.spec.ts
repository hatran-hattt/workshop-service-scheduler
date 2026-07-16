/**
 * Unit tests for IdempotencyService [U]
 *
 * hashBody
 *   - produces the same hash for identical bodies
 *   - produces a different hash when any field changes
 *
 * check
 *   Success — new key
 *     - returns null when the key is not in the cache
 *   Success — matching replay
 *     - returns the cached response when key found and hash matches
 *   Error — 400 BadRequestException
 *     - key found but stored hash does not match (key reused for a different body)
 *
 * cache
 *   - stores the body hash and response with EX (10-minute TTL)
 */

import { BadRequestException } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';

const BODY = {
  vehicle_id: '00000000-0000-0000-0000-000000000001',
  dealership_id: '00000000-0000-0000-0000-000000000002',
  workshop_service_id: '00000000-0000-0000-0000-000000000003',
  start_time: '2030-06-15T09:00:00Z',
};

const CACHED_RESPONSE = { appointment_id: 'appt-001', status: 'CONFIRMED' };

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let mockRedis: { get: jest.Mock; set: jest.Mock };

  beforeEach(() => {
    mockRedis = { get: jest.fn(), set: jest.fn() };
    service = new IdempotencyService(mockRedis as any);
  });

  // ─── hashBody ─────────────────────────────────────────────────────────────

  describe('hashBody', () => {
    it('produces the same hash for identical bodies', () => {
      expect(service.hashBody(BODY)).toBe(service.hashBody({ ...BODY }));
    });

    it('produces a different hash when vehicle_id changes', () => {
      const other = { ...BODY, vehicle_id: '00000000-0000-0000-0000-000000000099' };
      expect(service.hashBody(BODY)).not.toBe(service.hashBody(other));
    });
  });

  // ─── check ────────────────────────────────────────────────────────────────

  describe('check', () => {
    it('returns null for a new key (cache miss)', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await service.check('user-001', 'key-abc', service.hashBody(BODY));
      expect(result).toBeNull();
    });

    it('returns the cached response when hash matches', async () => {
      const hash = service.hashBody(BODY);
      mockRedis.get.mockResolvedValue(JSON.stringify({ hash, response: CACHED_RESPONSE }));
      const result = await service.check('user-001', 'key-abc', hash);
      expect(result).toEqual(CACHED_RESPONSE);
    });

    it('throws BadRequestException when key found but hash does not match', async () => {
      const storedHash = service.hashBody(BODY);
      const differentHash = service.hashBody({ ...BODY, start_time: '2030-06-16T09:00:00Z' });
      mockRedis.get.mockResolvedValue(JSON.stringify({ hash: storedHash, response: CACHED_RESPONSE }));
      await expect(service.check('user-001', 'key-abc', differentHash)).rejects.toThrow(BadRequestException);
    });
  });

  // ─── cache ────────────────────────────────────────────────────────────────

  describe('cache', () => {
    it('stores body hash and response in Redis with 600-second TTL', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const hash = service.hashBody(BODY);
      await service.cache('user-001', 'key-abc', hash, CACHED_RESPONSE);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'idempotency:user-001:key-abc',
        JSON.stringify({ hash, response: CACHED_RESPONSE }),
        'EX',
        600,
      );
    });
  });
});
