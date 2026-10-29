-- migrate:up
-- 交付记录: 每一次把授权码发给客户都留一条，用于回答"这个码发过几次、发到哪、成没成功"。
-- 此前只有审计里的一行 action，既不能统计重发次数，也看不到送达结果。
create table license_deliveries (
  id                   uuid primary key,
  tenant_id            uuid not null references tenants(id),
  license_id           uuid references licenses(id),
  batch_id             uuid references license_batches(id),
  channel              text not null check (channel in ('email','sms')),
  -- 收件地址是个人信息, 与其它表一致走 AES 加密存储
  to_addr_enc          bytea not null,
  code_count           integer not null default 1 check (code_count > 0),
  status               text not null check (status in ('sent','failed')),
  provider_message_id  text,
  error                text,
  delivered_by         uuid,
  created_at           timestamptz not null default now()
);

create index idx_deliveries_license on license_deliveries (tenant_id, license_id, created_at desc);
create index idx_deliveries_batch on license_deliveries (tenant_id, batch_id, created_at desc);

-- 新表不在 0001 的 RLS 循环清单里, 必须显式启用, 否则会绕过多租户隔离
alter table license_deliveries enable row level security;
alter table license_deliveries force row level security;
create policy tenant_isolation on license_deliveries using (
  current_setting('app.bypass_rls', true) = 'on'
  or tenant_id = lp_current_tenant_id()
) with check (
  current_setting('app.bypass_rls', true) = 'on'
  or tenant_id = lp_current_tenant_id()
);

grant select, insert, update, delete on license_deliveries to lp_app;

-- migrate:down
drop table if exists license_deliveries;
