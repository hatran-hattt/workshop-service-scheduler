import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis.token';

const IDEMPOTENCY_TTL_SECONDS = 600; // 10-minute TTL per DD §2.7
const KEY_PREFIX = 'idempotency';

export type CachedResponse = Record<string, unknown>;

/** Handles idempotency caching for the appointments endpoint (DD §2.7, §3.2 Step 3). */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Produces a SHA-256 hash of the canonical request body for comparison across retries. */
  hashBody(body: {
    vehicle_id: string;
    dealership_id: string;
    workshop_service_id: string;
    start_time: string;
  }): string {
    const canonical = JSON.stringify({
      vehicle_id: body.vehicle_id,
      dealership_id: body.dealership_id,
      workshop_service_id: body.workshop_service_id,
      start_time: body.start_time,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Looks up (userId, key) in the idempotency store.
   * Returns the cached response on a matching retry, null on a new key.
   * @throws INVALID_ARGUMENT (400) if the key is reused with a different body hash.
   */
  async check(
    userId: string,
    key: string,
    bodyHash: string,
  ): Promise<CachedResponse | null> {
    const raw = await this.redis.get(`${KEY_PREFIX}:${userId}:${key}`);
    if (!raw) return null;

    const { hash, response } = JSON.parse(raw) as { hash: string; response: CachedResponse };

    // Same key, different body — client is misusing the idempotency key
    if (hash !== bodyHash) {
      throw new BadRequestException('Idempotency-Key reused with a different request body');
    }

    return response;
  }

  /** Stores the response for (userId, key) with a 10-minute TTL. */
  async cache(
    userId: string,
    key: string,
    bodyHash: string,
    response: CachedResponse,
  ): Promise<void> {
    await this.redis.set(
      `${KEY_PREFIX}:${userId}:${key}`,
      JSON.stringify({ hash: bodyHash, response }),
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
    );
  }
}
