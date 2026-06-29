import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

const DEFAULT_DATABASE_URL =
  'postgresql://ticket_poc:ticket_poc_password@localhost:5432/ticket_poc';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });

  connect(): Promise<PoolClient> {
    return this.pool.connect();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
