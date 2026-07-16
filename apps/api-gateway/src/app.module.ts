import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import Redis from 'ioredis';
import { AppointmentsController } from './appointments/appointments.controller';
import { IdempotencyService } from './idempotency/idempotency.service';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { REDIS_CLIENT } from './redis.token';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: 'SCHEDULER_SERVICE',
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: 'scheduler',
            protoPath: join(__dirname, '../../../proto/scheduler.proto'),
            url: `${process.env.SCHEDULER_GRPC_HOST ?? 'localhost'}:${process.env.SCHEDULER_GRPC_PORT ?? '5000'}`,
            loader: {
              keepCase: true, // preserve snake_case field names so request/response objects match proto field names
              longs: Number,
              enums: String,
              includeDirs: [join(__dirname, '../../../proto')],
            },
          },
        }),
      },
    ]),
  ],
  controllers: [AppointmentsController],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () =>
        new Redis({
          host: process.env['REDIS_HOST'] ?? 'localhost',
          port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
        }),
    },
    IdempotencyService,
    RateLimitGuard,
  ],
})
export class AppModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
