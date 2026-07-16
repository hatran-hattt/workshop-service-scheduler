/**
 * Unit tests for RateLimitGuard [U]
 *
 * canActivate
 *   Success
 *     - returns true and does not expire the key on the first request in the window (incr result = 1 → sets TTL)
 *     - returns true when count is below the limit (incr result = 10)
 *     - returns true for a new window even if the previous window was over limit
 *   Error — 429 TOO_MANY_REQUESTS
 *     - throws when count exceeds 10 (incr result = 11)
 */

import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { RateLimitGuard, RATE_LIMIT_WINDOW_MS } from './rate-limit.guard';

function makeContext(userId: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ userId }) }),
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let mockRedis: { incr: jest.Mock; pexpire: jest.Mock };

  beforeEach(() => {
    mockRedis = { incr: jest.fn(), pexpire: jest.fn().mockResolvedValue(1) };
    guard = new RateLimitGuard(mockRedis as any);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── Success ──────────────────────────────────────────────────────────────

  it('returns true and sets TTL on the first request in the window (count = 1)', async () => {
    mockRedis.incr.mockResolvedValue(1);
    await expect(guard.canActivate(makeContext('user-001'))).resolves.toBe(true);
    expect(mockRedis.pexpire).toHaveBeenCalledWith(expect.any(String), RATE_LIMIT_WINDOW_MS);
  });

  it('returns true when count is exactly at the limit (count = 10)', async () => {
    mockRedis.incr.mockResolvedValue(10);
    await expect(guard.canActivate(makeContext('user-001'))).resolves.toBe(true);
  });

  it('returns true in a new window even if the previous window was exhausted', async () => {
    // Advance time past one full window
    jest.setSystemTime(Date.now() + RATE_LIMIT_WINDOW_MS);
    mockRedis.incr.mockResolvedValue(1);
    await expect(guard.canActivate(makeContext('user-001'))).resolves.toBe(true);
  });

  // ─── 429 TOO_MANY_REQUESTS ────────────────────────────────────────────────

  it('throws 429 when count exceeds the limit (count = 11)', async () => {
    mockRedis.incr.mockResolvedValue(11);
    await expect(guard.canActivate(makeContext('user-001'))).rejects.toThrow(
      expect.objectContaining({ status: HttpStatus.TOO_MANY_REQUESTS }),
    );
  });
});
