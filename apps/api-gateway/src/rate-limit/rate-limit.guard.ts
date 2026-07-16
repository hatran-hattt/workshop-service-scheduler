import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { Request } from 'express';
import { REDIS_CLIENT } from '../redis.token';

export const RATE_LIMIT_REQUESTS = 10;        // per DD §2.7 — 10 requests per window
export const RATE_LIMIT_WINDOW_MS = 60_000;   // 1-minute fixed window

/** Enforces per-authenticated-user rate limiting (10 req/min) on this endpoint per DD §2.7. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { userId: string }>();
    const window = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
    const key = `rate_limit:${req.userId}:${window}`;

    const count = await this.redis.incr(key);

    // Set TTL on first hit so the key expires one window after it was created
    if (count === 1) {
      await this.redis.pexpire(key, RATE_LIMIT_WINDOW_MS);
    }

    if (count > RATE_LIMIT_REQUESTS) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }
}
