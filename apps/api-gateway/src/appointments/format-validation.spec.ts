/**
 * Unit tests for validateRequestFormat [U]
 *
 * validateRequestFormat
 *   Success
 *     - valid headers and body passes without throwing
 *   Error — 400 BadRequestException
 *     Header validation
 *       - Idempotency-Key header missing
 *       - Content-Type header missing
 *       - Content-Type is not application/json
 *     Body — ID fields
 *       - vehicle_id missing
 *       - vehicle_id malformed (not a UUID)
 *       - dealership_id missing
 *       - dealership_id malformed
 *       - workshop_service_id missing
 *       - workshop_service_id malformed
 *     Body — start_time
 *       - start_time missing
 *       - start_time is a plain date string (no time component)
 *       - start_time has a non-UTC timezone offset (not Z suffix)
 *       - start_time is lexically valid but an impossible calendar date (month 13)
 */

import { BadRequestException } from '@nestjs/common';
import { validateRequestFormat, RequestHeaders, RequestBody } from './format-validation';

const VALID_HEADERS: RequestHeaders = {
  idempotencyKey: 'key-abc',
  contentType: 'application/json',
};

const VALID_BODY: RequestBody = {
  vehicle_id: '00000000-0000-0000-0000-000000000001',
  dealership_id: '00000000-0000-0000-0000-000000000002',
  workshop_service_id: '00000000-0000-0000-0000-000000000003',
  start_time: '2030-06-15T09:00:00Z',
};

function expectBadRequest(headers: RequestHeaders, body: RequestBody): void {
  expect(() => validateRequestFormat(headers, body)).toThrow(BadRequestException);
}

describe('validateRequestFormat', () => {
  // ─── Success ────────────────────────────────────────────────────────────

  it('passes for valid headers and body', () => {
    expect(() => validateRequestFormat(VALID_HEADERS, VALID_BODY)).not.toThrow();
  });

  // ─── Header validation ───────────────────────────────────────────────────

  describe('Idempotency-Key header', () => {
    it('throws when Idempotency-Key is missing', () => {
      expectBadRequest({ ...VALID_HEADERS, idempotencyKey: undefined }, VALID_BODY);
    });
  });

  describe('Content-Type header', () => {
    it('throws when Content-Type is missing', () => {
      expectBadRequest({ ...VALID_HEADERS, contentType: undefined }, VALID_BODY);
    });

    it('throws when Content-Type is not application/json', () => {
      expectBadRequest({ ...VALID_HEADERS, contentType: 'text/plain' }, VALID_BODY);
    });
  });

  // ─── Body — ID fields ────────────────────────────────────────────────────

  describe('vehicle_id', () => {
    it('throws when vehicle_id is missing', () => {
      expectBadRequest(VALID_HEADERS, { ...VALID_BODY, vehicle_id: undefined });
    });

    it('throws when vehicle_id is not a UUID', () => {
      expectBadRequest(VALID_HEADERS, { ...VALID_BODY, vehicle_id: 'not-a-uuid' });
    });
  });

  describe('dealership_id', () => {
    it('throws when dealership_id is missing', () => {
      expectBadRequest(VALID_HEADERS, { ...VALID_BODY, dealership_id: undefined });
    });

    it('throws when dealership_id is not a UUID', () => {
      expectBadRequest(VALID_HEADERS, { ...VALID_BODY, dealership_id: 'not-a-uuid' });
    });
  });

  describe('workshop_service_id', () => {
    it('throws when workshop_service_id is missing', () => {
      expectBadRequest(VALID_HEADERS, { ...VALID_BODY, workshop_service_id: undefined });
    });

    it('throws when workshop_service_id is not a UUID', () => {
      expectBadRequest(VALID_HEADERS, { ...VALID_BODY, workshop_service_id: 'not-a-uuid' });
    });
  });

  // ─── Body — start_time ────────────────────────────────────────────────────

  describe('start_time', () => {
    it('throws when start_time is missing', () => {
      expectBadRequest(VALID_HEADERS, { ...VALID_BODY, start_time: undefined });
    });

    it('throws when start_time is a plain date string (no time component)', () => {
      expectBadRequest(VALID_HEADERS, { ...VALID_BODY, start_time: '2030-06-15' });
    });

    it('throws when start_time has a non-UTC timezone offset (not Z suffix)', () => {
      expectBadRequest(VALID_HEADERS, { ...VALID_BODY, start_time: '2030-06-15T09:00:00+05:00' });
    });

    it('throws when start_time matches the pattern but is an impossible calendar date', () => {
      expectBadRequest(VALID_HEADERS, { ...VALID_BODY, start_time: '2030-13-15T09:00:00Z' });
    });
  });
});
