import type { LpTx } from '@lp/db';
import { uuidv7 } from '@lp/db';

/**
 * 事务性 Outbox: 与业务写同事务落库, 由 worker/outbox-relay 异步发布到 Kafka.
 * 骨架期 relay 仅落控制台并标记 published(Kafka 接入按设计文档 P3/P4).
 */
export async function emitOutbox(
  tx: LpTx,
  type: string,
  tenantId: string | null,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx
    .insertInto('events')
    .values({
      id: uuidv7(),
      type,
      tenant_id: tenantId,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      payload,
      created_at: new Date(),
      published_at: null,
    })
    .execute();
}
