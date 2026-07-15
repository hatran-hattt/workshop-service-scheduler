import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AppointmentsController } from './appointments/appointments.controller';

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
})
export class AppModule {}
