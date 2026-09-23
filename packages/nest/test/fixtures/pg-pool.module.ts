import { type DynamicModule, Module } from '@nestjs/common';
import type { Pool } from 'pg';

export const PG_POOL = Symbol('PG_POOL');

@Module({})
export class PgPoolModule {
  static forRoot(pool: Pool): DynamicModule {
    return {
      module: PgPoolModule,
      providers: [{ provide: PG_POOL, useValue: pool }],
      exports: [PG_POOL],
    };
  }
}
