import { Module, OnModuleDestroy, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { SchedulerController } from './scheduler.controller';
import { CreateAppointmentService, PG_POOL } from './create-appointment/create-appointment.service';

@Module({
  controllers: [SchedulerController],
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => new Pool({
        host: process.env.POSTGRES_HOST ?? 'localhost',
        port: Number(process.env.POSTGRES_PORT ?? 5432),
        database: process.env.POSTGRES_DB ?? 'workshop_scheduler',
        user: process.env.POSTGRES_USER ?? 'workshop',
        password: process.env.POSTGRES_PASSWORD ?? 'workshop_secret',
      }),
    },
    CreateAppointmentService,
  ],
})
export class AppModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
