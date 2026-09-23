import { SetMetadata } from '@nestjs/common';

export const RELIABLE_CONSUMER_METADATA = Symbol('RELIABLE_CONSUMER_METADATA');

/** Marks a method as the handler for outbox messages of the given `type`. Exactly one handler per type across the whole app; a second one fails at boot, not at runtime. */
export function ReliableConsumer(type: string): MethodDecorator {
  return SetMetadata(RELIABLE_CONSUMER_METADATA, type);
}
