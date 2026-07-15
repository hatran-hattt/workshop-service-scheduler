import { Module, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { Redis } from 'ioredis';

@Module({})
export class AppModule implements OnModuleInit {
  private readonly logger = new Logger(AppModule.name);

  async onModuleInit(): Promise<void> {
    await this.checkPostgres();
    await this.checkRedis();
  }

  private async checkPostgres(): Promise<void> {
    const pool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'localhost',
      port: Number(process.env.POSTGRES_PORT ?? '5432'),
      database: process.env.POSTGRES_DB ?? 'workshop_scheduler',
      user: process.env.POSTGRES_USER ?? 'workshop',
      password: process.env.POSTGRES_PASSWORD ?? 'workshop_secret',
    });
    try {
      await pool.query('SELECT 1');
      this.logger.log('Postgres connection OK');
    } finally {
      await pool.end();
    }
  }

  private async checkRedis(): Promise<void> {
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? '6379'),
    });
    try {
      await redis.ping();
      this.logger.log('Redis connection OK');
    } finally {
      redis.disconnect();
    }
  }
}
