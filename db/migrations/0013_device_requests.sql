-- migrate:up
-- 远程授权: 客户端在没有授权码时上报设备，开发者在后台批准后客户端再完成激活。
-- 这样设备码可以口头/扫码报给客服，不必先线下发码。
create table device_requests (
  id             uuid primary key,
  request_code   text not null unique,          -- 展示给用户的短码 XXXX-XXXX
  tenant_id      uuid not null references tenants(id),
  product_id     uuid not null references products(id),
  fp_type        text not null check (fp_type in
                   ('install_id','openid','unionid','machine_id','account')),
  fingerprint    bytea not null,                -- 设备指纹的 HMAC
  platform       text not null,
  app_version    text,
  user_id        text,                          -- 客户端上报的席位归属(可选)
  status         text not null default 'pending'
                   check (status in ('pending','approved','rejected','expired')),
  license_id     uuid references licenses(id),
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);

create index idx_device_requests_pending on device_requests (tenant_id, status, created_at desc);
create index idx_device_requests_expire on device_requests (expires_at) where status = 'pending';

-- 新表必须显式启用 RLS, 否则会绕过多租户隔离
alter table device_requests enable row level security;
alter table device_requests force row level security;
create policy tenant_isolation on device_requests using (
  current_setting('app.bypass_rls', true) = 'on'
  or tenant_id = lp_current_tenant_id()
) with check (
  current_setting('app.bypass_rls', true) = 'on'
  or tenant_id = lp_current_tenant_id()
);

grant select, insert, update, delete on device_requests to lp_app;

-- migrate:down
drop table if exists device_requests;
