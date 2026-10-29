import { sql } from 'kysely';
import { createDb, withSystemTx } from '@lp/db';
import { emitOutbox } from '@lp/events';
import { getConfig } from '@lp/config';
import { buildChannels, deliverPending } from '@lp/notify';
import { relayOnce } from './relay';
import { dispatchOnce } from './dispatcher';
import { notifyOnce } from './notifier';
import { createHealthState, startHealthServer } from './health';
import { runRetentionOnce } from './retention';

/**
 * worker(骨架): 5s 节拍串行跑
 *  1) expireActivated: activated + expires_at < now -> expired(+事件)
 *  2) expireUnactivated: issued 超激活期 -> expired(+事件)
 *  3) relay: outbox 发布打点 + webhook 扇出
 *  4) webhook dispatcher: 签名投递/退避/死信
 *  5) notifier: 到期 30/7/1 提醒入队(去重) + expire_warning 事件
 *  6) notify deliverer: 入队的提醒真实投递(邮件/短信), 失败退避至 dead
 * 设计文档 §16 的 export-worker/audit-archiver/partition-keeper 按阶段交付.
 */
const cfg = getConfig();
const db = createDb(cfg.DATABASE_URL);
const channels = buildChannels();
const health = createHealthState();
let stopped = false;

if (!channels.email) {
  console.warn('[worker] 未配置 SMTP 且关闭了 console fallback: 邮件通知将置 blocked');
}

async function expireActivated(): Promise<void> {
  const n = await withSystemTx(db, async (tx) => {
    const rows = await tx
      .updateTable('licenses')
      .set({ status: 'expired', version: sql`version + 1`, updated_at: new Date() })
      .where('status', '=', 'activated')
      .where('expires_at', 'is not', null)
      .where('expires_at', '<', new Date())
      .returning(['id', 'tenant_id'])
      .execute();
    for (const r of rows) {
      await emitOutbox(tx, 'license.expired', r.tenant_id, 'license', r.id, {
        license_id: r.id,
      });
    }
    return rows.length;
  });
  if (n > 0) console.log(`[expire-scanner] ${n} license(s) -> expired`);
}

async function expireUnactivated(): Promise<void> {
  const n = await withSystemTx(db, async (tx) => {
    const rows = await tx
      .updateTable('licenses')
      .set({ status: 'expired', version: sql`version + 1`, updated_at: new Date() })
      .where('status', '=', 'issued')
      .where('activate_within_days', '>', 0)
      .where(sql`issued_at + make_interval(days => activate_within_days)`, '<', new Date())
      .returning(['id', 'tenant_id'])
      .execute();
    for (const r of rows) {
      await emitOutbox(tx, 'license.expired', r.tenant_id, 'license', r.id, {
        license_id: r.id,
        cause: 'activate_window_exceeded',
      });
    }
    return rows.length;
  });
  if (n > 0) console.log(`[expire-scanner] ${n} unactivated license(s) -> expired`);
}

let lastRetentionAt = 0;
const RETENTION_INTERVAL_MS = 3_600_000;

async function tick(): Promise<void> {
  const startedAt = Date.now();
  try {
    await expireActivated();
    await expireUnactivated();
    const relayed = await relayOnce(db);
    const dispatched = await dispatchOnce(db);
    const notified = await notifyOnce(db);
    const d = await deliverPending({ db, channels });
    if (d.processed > 0) {
      console.log(
        `[notify] processed=${d.processed} sent=${d.sent} retrying=${d.retrying} dead=${d.dead} blocked=${d.blocked}`,
      );
    }
    // 数据清理每小时一次: 每 5 秒跑一遍纯属浪费, 还可能长时间持锁
    if (Date.now() - lastRetentionAt > RETENTION_INTERVAL_MS) {
      lastRetentionAt = Date.now();
      await runRetentionOnce(db);
    }
    health.lastTickAt = Date.now();
    health.lastTickMs = Date.now() - startedAt;
    health.ticks += 1;
    health.lastError = null;
    health.lastSummary = {
      relayed,
      dispatched: dispatched.processed,
      notified,
      notify_sent: d.sent,
      notify_blocked: d.blocked,
    };
  } catch (e) {
    // 失败也要记时间: 否则探活会把"一直在报错"显示成"一切正常"
    health.lastError = (e as Error).message;
    health.lastTickMs = Date.now() - startedAt;
    console.error('[worker] tick failed:', (e as Error).message);
  }
}

async function main(): Promise<void> {
  const cfg = getConfig();
  console.log(`[worker] started db=${cfg.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`);
  await tick();
  const timer = setInterval(() => void tick(), 5000);
  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    void db.destroy().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // 探活在 shutdown 定义之后启动, 避免闭包引用未初始化的绑定
  startHealthServer(health, cfg.PORT_WORKER, shutdown);
}

void main();
