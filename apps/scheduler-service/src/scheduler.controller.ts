import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';

@Controller()
export class SchedulerController {
  @GrpcMethod('SchedulerService', 'Ping')
  ping(_data: Record<string, never>): { message: string } {
    return { message: 'pong' };
  }
}
