import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, INestMicroservice } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import * as supertest from 'supertest';

import { AppModule as SchedulerAppModule } from '../../scheduler-service/src/app.module';
import { AppModule as GatewayAppModule } from '../src/app.module';

// Use a port that won't collide with a running dev instance.
const TEST_GRPC_PORT = '50099';

jest.setTimeout(30000);

describe('Phase 1.3 — walking skeleton: Gateway → gRPC → Scheduler Service', () => {
  let gateway: INestApplication;
  let scheduler: INestMicroservice;

  beforeAll(async () => {
    // Must be set before compile() so the gateway's registerAsync factory picks them up.
    process.env.SCHEDULER_GRPC_HOST = 'localhost';
    process.env.SCHEDULER_GRPC_PORT = TEST_GRPC_PORT;

    scheduler = await NestFactory.createMicroservice<MicroserviceOptions>(SchedulerAppModule, {
      transport: Transport.GRPC,
      options: {
        package: 'scheduler',
        protoPath: join(__dirname, '../../../proto/scheduler.proto'),
        url: `0.0.0.0:${TEST_GRPC_PORT}`,
      },
      logger: false,
    });
    await scheduler.listen();

    const module: TestingModule = await Test.createTestingModule({
      imports: [GatewayAppModule],
    }).compile();

    gateway = module.createNestApplication();
    gateway.useLogger(false);
    await gateway.init();
  });

  afterAll(async () => {
    await gateway.close();
    await scheduler.close();
  });

  it('POST /api/v1/ownership/appointments returns pong from Scheduler Service', async () => {
    await supertest(gateway.getHttpServer())
      .post('/api/v1/ownership/appointments')
      .expect(201)
      .expect({ message: 'pong' });
  });
});
