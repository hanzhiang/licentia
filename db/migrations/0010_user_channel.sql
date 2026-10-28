-- migrate:up
-- 渠道账号的数据边界: 一个用户最多绑定一个渠道。
-- 绑定后该账号只能看到/发放本渠道的授权码, 而不是整个租户的全部授权。
alter table users add column if not exists channel_id uuid references channels(id);

create index if not exists idx_users_channel on users (tenant_id, channel_id)
  where channel_id is not null;

-- migrate:down
drop index if exists idx_users_channel;
alter table users drop column if exists channel_id;
