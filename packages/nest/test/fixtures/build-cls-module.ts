import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import type { DynamicModule } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import type { Pool } from 'pg';
import { TransactionalAdapterPg } from '../../src/index.js';
import { PG_POOL, PgPoolModule } from './pg-pool.module.js';

export function buildClsModule(pool: Pool): DynamicModule {
  return ClsModule.forRoot({
    global: true,
    plugins: [
      new ClsPluginTransactional({
        adapter: new TransactionalAdapterPg({ poolToken: PG_POOL }),
        imports: [PgPoolModule.forRoot(pool)],
      }),
    ],
  });
}
