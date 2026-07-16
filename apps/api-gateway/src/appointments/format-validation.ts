import { BadRequestException } from '@nestjs/common';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Requires the Z suffix — the gateway contract specifies UTC timestamps (DD §2.4)
const ISO8601_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export interface RequestHeaders {
  idempotencyKey: string | undefined;
  contentType: string | undefined;
}

export interface RequestBody {
  vehicle_id?: string;
  dealership_id?: string;
  workshop_service_id?: string;
  start_time?: string;
}

/** Validates request headers and body format — DD §3.2 Step 2. */
export function validateRequestFormat(headers: RequestHeaders, body: RequestBody): void {
  // Idempotency-Key header must be present (DD §2.2, §2.7)
  if (!headers.idempotencyKey) {
    throw new BadRequestException('Missing required header: Idempotency-Key');
  }

  // Content-Type must be application/json (DD §2.2)
  if (!headers.contentType?.toLowerCase().startsWith('application/json')) {
    throw new BadRequestException('Content-Type must be application/json');
  }

  // UUID format for all ID fields (DD §2.4)
  if (!body.vehicle_id || !UUID_RE.test(body.vehicle_id)) {
    throw new BadRequestException('vehicle_id must be a valid UUID');
  }
  if (!body.dealership_id || !UUID_RE.test(body.dealership_id)) {
    throw new BadRequestException('dealership_id must be a valid UUID');
  }
  if (!body.workshop_service_id || !UUID_RE.test(body.workshop_service_id)) {
    throw new BadRequestException('workshop_service_id must be a valid UUID');
  }

  // ISO 8601 UTC timestamp; also check the resulting Date is finite to reject invalid calendars
  // (e.g. month 13 matches the regex but produces an invalid Date)
  if (
    !body.start_time ||
    !ISO8601_UTC_RE.test(body.start_time) ||
    !isFinite(new Date(body.start_time).getTime())
  ) {
    throw new BadRequestException('start_time must be a valid ISO 8601 UTC timestamp (e.g. 2026-08-01T09:00:00Z)');
  }
}
