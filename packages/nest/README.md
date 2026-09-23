# @reliable/nest

NestJS integration for [`@reliable/core`](../core) and
[`@reliable/postgres`](../postgres). `ReliableModule`, `ReliablePublisher`,
`@ReliableConsumer()`, and a raw-`pg` adapter for
[`@nestjs-cls/transactional`](https://github.com/Papooch/nestjs-cls).

## Why a custom `TransactionalAdapterPg`

`@nestjs-cls/transactional` ships adapters for Prisma, TypeORM, Drizzle,
Kysely, Knex, Mongoose/MongoDB, and pg-promise, but **not for raw `pg`**.
Since `@reliable/postgres` is raw SQL by design (CDC_Technique.md §2.2),
`TransactionalAdapterPg` (in `src/transaction/`) fills that gap: it opens a
`BEGIN`/`COMMIT`/`ROLLBACK` on a checked-out `PoolClient` for the outer
transaction, and a `SAVEPOINT` for nested ones.

## Usage sketch

```ts
export const PG_POOL = Symbol('PG_POOL');

@Module({ providers: [{ provide: PG_POOL, useValue: pool }], exports: [PG_POOL] })
class DatabaseModule {}

ClsModule.forRoot({
  global: true,
  plugins: [
    new ClsPluginTransactional({
      adapter: new TransactionalAdapterPg({ poolToken: PG_POOL }),
      imports: [DatabaseModule],
    }),
  ],
});

ReliableModule.forRoot({
  outboxStore: new PostgresOutboxStore(pool, new Uuidv7Generator()),
  inboxStore: new PostgresInboxStore(pool),
  worker: { pollIntervalMs: 500, leaseTtlMs: 30_000 },
});
```

```ts
@Injectable()
class PayInvoice {
  constructor(private readonly reliable: ReliablePublisher) {}

  @Transactional()
  async execute(invoiceId: string) {
    await this.invoices.markAsPaid(invoiceId);
    await this.reliable.publish({ type: 'invoice.paid', key: invoiceId, payload: { invoiceId } });
  }
}

@Injectable()
class SendReceipt {
  @ReliableConsumer('invoice.paid')
  async handle(message: ReliableMessage, tools: HandlerTools) {
    await this.emailProvider.send({
      idempotencyKey: tools.idempotencyKey('resend.receipt'),
      ...
    });
  }
}
```

## Known limitation: esbuild + generic constructor parameters

Under Vitest/vite-node (esbuild's TS transform), `emitDecoratorMetadata`
does not reliably resolve a generic constructor parameter type like
`TransactionHost<TransactionalAdapterPg>`, nor, in this codebase, plain
class-token parameters in at least one observed case (`ConsumerRegistry`).
Every constructor parameter in this package that resolves by class token
uses an explicit `@Inject(Token)` rather than relying on
`design:paramtypes`. Applications built with plain `tsc`/`ts-node`/SWC are
unaffected; this only bit the test toolchain here. If you hit "Nest can't
resolve dependencies" with a healthy-looking constructor under Vitest, this
is almost certainly why.

## Tests

```bash
pnpm test
```

Real Testcontainers Postgres 16 + real `@nestjs/testing` applications, no
mocks. Covers the Etape 2 DoD: nested `@Transactional()` participation
across 3 service layers (commit and rollback), `NoTransactionContextError`
outside a transaction, boot-time failure on a duplicate
`@ReliableConsumer(type)`, and graceful shutdown releasing an in-flight
lease within `shutdownTimeoutMs` instead of waiting out the full lease TTL.
