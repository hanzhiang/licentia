-- migrate:up
-- 通知投递状态机(设计文档 §16): 原先 notifier 直接写 status='sent' 但邮件/短信从未真正发出,
-- 库里会显示"已提醒"而责任人收不到. 这里补齐投递所需的列与状态取值.
--
-- 状态: pending(待发) retrying(失败待重试) sent(已投递) dead(超限放弃) blocked(缺地址/通道未配置)
-- 旧数据中的 sent 无法证明真的投递过, 统一降级为 blocked 并标注原因.
alter table notifications_outbox
  drop constraint if exists notifications_outbox_status_check;

alter table notifications_outbox
  add column if not exists provider_message_id text,
  add column if not exists next_retry_at        timestamptz,
  add column if not exists updated_at           timestamptz not null default now();

update notifications_outbox
   set status = 'blocked',
       last_error = coalesce(last_error, 'legacy: 骨架期未接真实通道, 投递未知')
 where status = 'sent'
   and provider_message_id is null;

alter table notifications_outbox
  add constraint notifications_outbox_status_check
  check (status in ('pending','retrying','sent','failed','dead','blocked'));

create index if not exists idx_notif_due on notifications_outbox (scheduled_for, created_at)
  where status in ('pending','retrying');

-- migrate:down
drop index if exists idx_notif_due;
alter table notifications_outbox drop constraint if exists notifications_outbox_status_check;
alter table notifications_outbox
  drop column if exists provider_message_id,
  drop column if exists next_retry_at,
  drop column if exists updated_at;
alter table notifications_outbox
  add constraint notifications_outbox_status_check
  check (status in ('pending','sent','failed','dead'));
