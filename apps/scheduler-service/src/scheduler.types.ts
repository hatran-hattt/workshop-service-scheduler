// TypeScript interfaces for the SchedulerService gRPC contract.
// Field names are snake_case to match the proto definition.
// Timestamp.seconds is number because the loader is configured with longs: Number.

export interface Timestamp {
  seconds: number;
  nanos: number;
}

export interface CreateAppointmentRequest {
  vehicle_id: string;
  dealership_id: string;
  workshop_service_id: string;
  start_time: Timestamp;
  requested_user_id: string;
}

export interface Appointment {
  id: string;
  vehicle_id: string;
  dealership_id: string;
  workshop_service_id: string;
  service_bay_id: string;
  technician_id: string;
  start_time: Timestamp;
  end_time: Timestamp;
  status: string;  // "APPOINTMENT_STATUS_CONFIRMED" — enums: String loader option
  created_at: Timestamp;
}

export interface CreateAppointmentResponse {
  appointment: Appointment;
}
