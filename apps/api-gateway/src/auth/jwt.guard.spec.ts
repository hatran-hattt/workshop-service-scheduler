/**
 * Unit tests for JwtGuard [U]
 *
 * canActivate
 *   Success
 *     - valid token: returns true and sets req.userId to the token subject
 *   Error — 401 UnauthorizedException
 *     - Authorization header is missing
 *     - Authorization header present but without Bearer prefix
 *     - token is structurally malformed (not a valid JWT)
 *     - token is expired
 *     - token is signed with the wrong secret
 */

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { JwtGuard } from './jwt.guard';

const SECRET = 'test-secret';
const OTHER_SECRET = 'other-secret';

function makeContext(headers: Record<string, string | undefined>): ExecutionContext & { userId(): string | undefined } {
  const req: Record<string, unknown> = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    userId: () => req['userId'] as string | undefined,
  } as unknown as ExecutionContext & { userId(): string | undefined };
}

describe('JwtGuard', () => {
  let guard: JwtGuard;

  beforeEach(() => {
    process.env['JWT_SECRET'] = SECRET;
    guard = new JwtGuard();
  });

  afterEach(() => {
    delete process.env['JWT_SECRET'];
  });

  // ─── Success ──────────────────────────────────────────────────────────────

  it('returns true and sets req.userId to the token subject for a valid token', () => {
    const token = jwt.sign({ sub: 'user-001' }, SECRET, { expiresIn: '1h' });
    const ctx = makeContext({ authorization: `Bearer ${token}` });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(ctx.userId()).toBe('user-001');
  });

  // ─── 401 UnauthorizedException ────────────────────────────────────────────

  it('throws UnauthorizedException when Authorization header is missing', () => {
    expect(() => guard.canActivate(makeContext({}))).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when Authorization header has no Bearer prefix', () => {
    const token = jwt.sign({ sub: 'user-001' }, SECRET);
    expect(() => guard.canActivate(makeContext({ authorization: token }))).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException for a structurally malformed token', () => {
    expect(() =>
      guard.canActivate(makeContext({ authorization: 'Bearer not.a.jwt' })),
    ).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException for an expired token', () => {
    const token = jwt.sign({ sub: 'user-001' }, SECRET, { expiresIn: -1 });
    expect(() =>
      guard.canActivate(makeContext({ authorization: `Bearer ${token}` })),
    ).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException for a token signed with the wrong secret', () => {
    const token = jwt.sign({ sub: 'user-001' }, OTHER_SECRET);
    expect(() =>
      guard.canActivate(makeContext({ authorization: `Bearer ${token}` })),
    ).toThrow(UnauthorizedException);
  });
});
