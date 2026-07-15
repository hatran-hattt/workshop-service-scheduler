import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Temporary HTTP listener for Phase 0 sanity check.
  // Replaced with gRPC transport in Phase 1.
  await app.listen(3001);
}
bootstrap();
