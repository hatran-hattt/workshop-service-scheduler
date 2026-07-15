import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { CreateAppointmentService } from './create-appointment/create-appointment.service';
import {
  CreateAppointmentRequest,
  CreateAppointmentResponse,
} from './scheduler.types';

@Controller()
export class SchedulerController {
  constructor(
    private readonly createAppointmentService: CreateAppointmentService,
  ) {}

  @GrpcMethod('SchedulerService', 'CreateAppointment')
  createAppointment(
    data: CreateAppointmentRequest,
  ): Promise<CreateAppointmentResponse> {
    return this.createAppointmentService.execute(data);
  }
}
