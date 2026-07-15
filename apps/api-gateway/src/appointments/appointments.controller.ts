import { Controller, Inject, OnModuleInit, Post } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable } from 'rxjs';

interface SchedulerServiceGrpcClient {
  ping(data: Record<string, never>): Observable<{ message: string }>;
}

@Controller('api/v1/ownership')
export class AppointmentsController implements OnModuleInit {
  private schedulerService!: SchedulerServiceGrpcClient;

  constructor(@Inject('SCHEDULER_SERVICE') private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.schedulerService = this.client.getService<SchedulerServiceGrpcClient>('SchedulerService');
  }

  @Post('appointments')
  createAppointment(): Observable<{ message: string }> {
    return this.schedulerService.ping({});
  }
}
