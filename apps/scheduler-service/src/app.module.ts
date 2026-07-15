import { Module } from '@nestjs/common';
import { SchedulerController } from './scheduler.controller';
import { CreateAppointmentService } from './create-appointment/create-appointment.service';

@Module({
  controllers: [SchedulerController],
  providers: [CreateAppointmentService],
})
export class AppModule {}
