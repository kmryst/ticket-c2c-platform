import 'dotenv/config';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: getRequiredDatabaseUrl(),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    max: 10,
  });

  constructor() {
    this.pool.on('error', (error) => {
      console.error('Unexpected pg pool error:', error);
    });
  }

  connect(): Promise<PoolClient> {
    return this.pool.connect();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

function getRequiredDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Copy .env.example to .env for local PoC runs.');
  }

  return process.env.DATABASE_URL;
}
