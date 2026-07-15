import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: 'scheduler',
      protoPath: join(__dirname, '../../../proto/scheduler.proto'),
      url: `${process.env.SCHEDULER_GRPC_HOST ?? '0.0.0.0'}:${process.env.SCHEDULER_GRPC_PORT ?? '5000'}`,
      loader: {
        keepCase: true, // preserve snake_case field names so service code and proto field names match
        longs: Number,
        enums: String,
        includeDirs: [join(__dirname, '../../../proto')],
      },
    },
  });
  await app.listen();
}
bootstrap();
