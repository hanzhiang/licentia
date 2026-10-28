-- migrate:up
create extension if not exists pgcrypto;

-- 应用角色: NO BYPASSRLS, 所有 API 通过它连接(连接串见 .env DATABASE_URL)
do $$ begin
  if not exists (select from pg_roles where rolname = 'lp_app') then
    create role lp_app login password 'lp' nobypassrls;
  end if;
end $$;

-- ========= 基础 =========
create table tenants (
  id          uuid primary key,
  code        text not null unique,
  name        text not null,
  status      text not null default 'active' check (status in ('active','suspended','closed')),
  plan        text not null default 'standard',
  settings    jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table users (
  id            uuid primary key,
  tenant_id     uuid references tenants(id),
  email         text not null,
  phone_hash    bytea,
  password_hash text,
  status        text not null default 'active' check (status in ('active','disabled')),
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index uq_users_tenant_email on users
  ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), email)
  where deleted_at is null;

create table roles (
  id   uuid primary key,
  code text not null unique,
  name text not null
);
create table role_permissions (
  role_code text not null references roles(code),
  perm      text not null,
  primary key (role_code, perm)
);
create table user_roles (
  user_id   uuid not null references users(id),
  role_code text not null references roles(code),
  primary key (user_id, role_code)
);
create table refresh_tokens (
  id          uuid primary key,
  user_id     uuid not null references users(id),
  token_hash  bytea not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  ip          inet,
  ua          text
);

-- ========= 产品与策略 =========
create table products (
  id         uuid primary key,
  tenant_id  uuid not null references tenants(id),
  code       text not null,
  name       text not null,
  status     text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, code)
);
create table product_versions (
  id         uuid primary key,
  product_id uuid not null references products(id),
  version    text not null,
  status     text not null default 'supported' check (status in ('supported','deprecated','eol')),
  created_at timestamptz not null default now(),
  unique (product_id, version)
);
create table product_features (
  id         uuid primary key,
  product_id uuid not null references products(id),
  code       text not null,
  name       text not null,
  unique (product_id, code)
);
create table policies (
  id                  uuid primary key,
  tenant_id           uuid not null references tenants(id),
  product_id          uuid not null references products(id),
  code                text not null,
  name                text not null,
  kind                text not null check (kind in ('trial','standard','perpetual','subscription','floating')),
  duration_days       integer check (duration_days is null or duration_days between 1 and 36500),
  device_limit        integer not null default 1 check (device_limit between 1 and 100000),
  seat_limit          integer,
  concurrency_limit   integer,
  features            jsonb not null default '[]',
  offline_window_days integer not null default 7 check (offline_window_days between 0 and 90),
  heartbeat_hours     integer not null default 24 check (heartbeat_hours between 1 and 168),
  grace_hours         integer not null default 72,
  activate_within_days integer not null default 0,
  allow_renewal       boolean not null default true,
  renew_window_days   integer not null default 90,
  min_version         text,
  status              text not null default 'active' check (status in ('active','disabled')),
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (tenant_id, code),
  constraint ck_floating check (kind <> 'floating' or concurrency_limit is not null)
);

-- ========= 渠道 / 批次 / 授权码 =========
create table channels (
  id         uuid primary key,
  tenant_id  uuid not null references tenants(id),
  code       text not null,
  name       text not null,
  status     text not null default 'active',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, code)
);
create table license_batches (
  id              uuid primary key,
  tenant_id       uuid not null references tenants(id),
  product_id      uuid not null references products(id),
  policy_id       uuid not null references policies(id),
  channel_id      uuid references channels(id),
  code            text not null,
  quantity        integer not null check (quantity between 1 and 100000),
  status          text not null default 'pending'
                    check (status in ('pending','issuing','completed','failed','partially_failed')),
  issued_count    integer not null default 0,
  failed_count    integer not null default 0,
  note            text,
  csv_object_key  text,
  created_by      uuid not null,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  unique (tenant_id, code)
);
create table end_customers (
  id                 uuid primary key,
  tenant_id          uuid not null references tenants(id),
  name               text not null,
  type               text not null check (type in ('org','individual')),
  contact_phone_hash bytea,
  contact_email_enc  bytea,
  status             text not null default 'active',
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create table licenses (
  id                   uuid primary key,
  tenant_id            uuid not null references tenants(id),
  product_id           uuid not null references products(id),
  policy_id            uuid not null references policies(id),
  batch_id             uuid references license_batches(id),
  channel_id           uuid references channels(id),
  end_customer_id      uuid references end_customers(id),
  code                 text not null,
  code_hmac            bytea not null,
  code_cipher          bytea not null,
  kind                 text not null,
  status               text not null default 'issued'
                         check (status in ('issued','activated','suspended','revoked','expired')),
  device_limit         integer not null,
  seat_limit           integer,
  concurrency_limit    integer,
  features             jsonb not null,
  offline_window_days  integer not null,
  heartbeat_hours      integer not null,
  grace_hours          integer not null,
  activate_within_days integer not null default 0,
  renew_window_days    integer not null default 90,
  allow_renewal        boolean not null default true,
  min_version          text,
  duration_days        integer,
  issued_at            timestamptz not null default now(),
  activated_at         timestamptz,
  expires_at           timestamptz,
  suspended_at         timestamptz,
  revoked_at           timestamptz,
  revoked_reason       text,
  version              integer not null default 1,
  created_by           uuid not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index uq_licenses_code_hmac on licenses (code_hmac);
create index idx_licenses_tenant_status on licenses (tenant_id, status);
create index idx_licenses_batch on licenses (batch_id);
create index idx_licenses_expire_scan on licenses (expires_at)
  where status = 'activated' and expires_at is not null;
create index idx_licenses_renew_scan on licenses (expires_at) where status = 'expired';

-- ========= 设备与激活 =========
create table devices (
  id            uuid primary key,
  tenant_id     uuid not null references tenants(id),
  product_id    uuid not null references products(id),
  fp_type       text not null
                  check (fp_type in ('install_id','openid','unionid','machine_id','account')),
  fingerprint   bytea not null,
  platform      text not null check (platform in
                  ('wechat_miniapp','android','ios','web','windows','macos','linux','server')),
  display_name  text,
  meta          jsonb not null default '{}',
  blocked       boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz
);
create unique index uq_devices on devices (tenant_id, product_id, fp_type, fingerprint);
create index idx_devices_last_seen on devices (tenant_id, last_seen_at);

create table license_activations (
  id              uuid primary key,
  tenant_id       uuid not null references tenants(id),
  license_id      uuid not null references licenses(id),
  device_id       uuid references devices(id),
  end_customer_id uuid references end_customers(id),
  status          text not null default 'active' check (status in ('active','released')),
  activated_at    timestamptz not null default now(),
  released_at     timestamptz,
  released_by     uuid,
  released_reason text,
  last_seen_at    timestamptz,
  client_meta     jsonb not null default '{}',
  constraint ck_act_target check (num_nonnulls(device_id, end_customer_id) = 1)
);
create unique index uq_act_license_device on license_activations (license_id, device_id)
  where device_id is not null and status = 'active';
create index idx_act_device on license_activations (device_id) where status = 'active';

create table client_tokens (
  token_hash    bytea primary key,
  activation_id uuid not null references license_activations(id),
  license_id    uuid not null references licenses(id),
  tenant_id     uuid not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index idx_ct_license on client_tokens (license_id);

-- ========= 续期 / 吊销申请 =========
create table renewals (
  id             uuid primary key,
  tenant_id      uuid not null references tenants(id),
  license_id     uuid not null references licenses(id),
  days           integer not null check (days between 1 and 36500),
  old_expires_at timestamptz,
  new_expires_at timestamptz not null,
  order_ref      text,
  source         text not null check (source in ('admin','open_api','portal')),
  operator_id    uuid,
  idem_key       text,
  created_at     timestamptz not null default now()
);
create unique index uq_renewal_order on renewals (license_id, order_ref) where order_ref is not null;
create unique index uq_renewal_idem on renewals (license_id, idem_key) where idem_key is not null;

create table revocation_requests (
  id           uuid primary key,
  tenant_id    uuid not null,
  license_id   uuid not null references licenses(id),
  reason       text not null,
  refund_ref   text,
  status       text not null default 'pending'
                 check (status in ('pending','approved','rejected','executed')),
  requested_by uuid not null,
  decided_by   uuid,
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- ========= 开放 API / Webhook =========
create table api_keys (
  id              uuid primary key,
  tenant_id       uuid not null references tenants(id),
  name            text not null,
  prefix          text not null,
  key_hash        bytea not null,
  scopes          text[] not null default '{validate}',
  rate_limit_qps  integer not null default 500,
  ip_allowlist    inet[] not null default '{}',
  status          text not null default 'active' check (status in ('active','revoked','rotated')),
  expires_at      timestamptz,
  last_used_at    timestamptz,
  rotated_from_id uuid,
  created_by      uuid not null,
  created_at      timestamptz not null default now()
);
create unique index uq_apikey_prefix on api_keys (prefix) where status <> 'revoked';

create table webhook_endpoints (
  id             uuid primary key,
  tenant_id      uuid not null references tenants(id),
  url            text not null,
  secret_cipher  bytea not null,
  events         text[] not null,
  status         text not null default 'active' check (status in ('active','disabled')),
  concurrency    integer not null default 5,
  failure_count  integer not null default 0,
  disabled_until timestamptz,
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create table webhook_deliveries (
  id              bigserial primary key,
  tenant_id       uuid not null,
  endpoint_id     uuid not null references webhook_endpoints(id),
  event_id        uuid not null,
  event_type      text not null,
  payload         jsonb not null,
  attempt         integer not null default 0,
  status          text not null default 'pending'
                    check (status in ('pending','success','failed','dead')),
  next_retry_at   timestamptz,
  response_status integer,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index idx_wd_due on webhook_deliveries (status, next_retry_at);

-- ========= 事务性 Outbox =========
create table events (
  id             uuid primary key,
  tenant_id      uuid,
  aggregate_type text not null,
  aggregate_id   uuid not null,
  type           text not null,
  payload        jsonb not null,
  created_at     timestamptz not null default now(),
  published_at   timestamptz
);
create index idx_events_unpublished on events (created_at) where published_at is null;

-- ========= 幂等 =========
create table idempotency_keys (
  tenant_id    uuid not null,
  idem_key     text not null,
  endpoint     text not null,
  request_hash bytea not null,
  status       text not null default 'processing'
                 check (status in ('processing','completed','failed')),
  http_status  integer,
  response     jsonb,
  locked_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  primary key (tenant_id, idem_key)
);

-- ========= 审计(月分区 + 哈希链, 骨架预建 2026-10 ~ 2027-01 分区) =========
create table audit_events (
  id           bigserial not null,
  tenant_id    uuid,
  occurred_at  timestamptz not null default now(),
  actor_type   text not null check (actor_type in
                 ('super_admin','tenant_admin','operator','support','finance',
                  'end_customer','api_key','system')),
  actor_id     text not null,
  action       text not null,
  resource_type text not null,
  resource_id  text not null,
  detail       jsonb not null default '{}',
  ip           inet,
  ua           text,
  request_id   text,
  prev_hash    bytea not null,
  entry_hash   bytea not null,
  primary key (id, occurred_at)
) partition by range (occurred_at);
create table audit_events_2026_10 partition of audit_events
  for values from ('2026-10-01') to ('2026-11-01');
create table audit_events_2026_11 partition of audit_events
  for values from ('2026-11-01') to ('2026-12-01');
create table audit_events_2026_12 partition of audit_events
  for values from ('2026-12-01') to ('2027-01-01');
create table audit_events_2027_01 partition of audit_events
  for values from ('2027-01-01') to ('2027-02-01');
create index idx_ae_tenant_time on audit_events (tenant_id, occurred_at desc);
create index idx_ae_resource on audit_events (resource_type, resource_id, occurred_at desc);

-- ========= 通知 / 导出 =========
create table notifications_outbox (
  id             uuid primary key,
  tenant_id      uuid not null,
  license_id     uuid,
  channel        text not null check (channel in ('email','sms','webhook_builtin')),
  template_code  text not null,
  to_addr_enc    bytea,
  payload        jsonb not null,
  scheduled_for  date not null,
  status         text not null default 'pending'
                   check (status in ('pending','sent','failed','dead')),
  retries        integer not null default 0,
  last_error     text,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  unique (license_id, template_code, scheduled_for)
);
create table export_jobs (
  id         uuid primary key,
  tenant_id  uuid not null,
  type       text not null,
  params     jsonb not null,
  status     text not null default 'pending'
               check (status in ('pending','running','completed','failed')),
  object_key text,
  row_count  integer,
  error      text,
  expires_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

-- ========= 报表视图(security_invoker: 视图以调用者身份执行, RLS 生效, 防跨租户泄漏) =========
create view v_channel_batch_stats with (security_invoker = on) as
select b.tenant_id,
       b.id as batch_id,
       b.channel_id,
       b.quantity,
       count(l.*) filter (where l.status <> 'issued')                  as activated_count,
       count(l.*) filter (where l.status in ('activated','suspended')) as active_license_count,
       count(l.*) filter (where l.status = 'revoked')                  as revoked_count,
       round(100.0 * count(*) filter (where l.status <> 'issued')
             / greatest(b.quantity, 1), 2)                             as activation_rate_pct
from license_batches b
left join licenses l on l.batch_id = b.id
group by b.tenant_id, b.id, b.channel_id, b.quantity;

-- ========= 租户隔离 RLS(所有含 tenant_id 的业务表; tenants/refresh_tokens 无该列不在内) =========
-- 安全取租户 GUC: 事务级 set_config 提交后 current_setting 会话级返回 ''(非 NULL),
-- 直接 ::uuid 会报 22P02 且 OR 不保证短路; STABLE 函数每语句求值一次并可参与索引 qual.
create or replace function lp_current_tenant_id() returns uuid
language sql stable parallel safe as $$
  select case
    when current_setting('app.tenant_id', true)
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then current_setting('app.tenant_id', true)::uuid
    else null
  end
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'users','products','policies','channels','license_batches',
    'end_customers','licenses','devices','license_activations','client_tokens','renewals',
    'revocation_requests','api_keys','webhook_endpoints','webhook_deliveries',
    'notifications_outbox','export_jobs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($f$
      create policy tenant_isolation on %I using (
        current_setting('app.bypass_rls', true) = 'on'
        or tenant_id = lp_current_tenant_id()
      ) with check (
        current_setting('app.bypass_rls', true) = 'on'
        or tenant_id = lp_current_tenant_id()
      ) $f$, t);
  end loop;
end $$;

-- 审计表: 无租户上下文的系统行仅 bypass 可见
alter table audit_events enable row level security;
create policy audit_isolation on audit_events using (
  current_setting('app.bypass_rls', true) = 'on'
  or tenant_id = lp_current_tenant_id()
);

-- ========= 应用角色授权 =========
grant usage on schema public to lp_app;
grant select, insert, update, delete on all tables in schema public to lp_app;
alter default privileges in schema public grant select, insert, update, delete on tables to lp_app;
grant usage, select on all sequences in schema public to lp_app;
alter default privileges in schema public grant usage, select on sequences to lp_app;
do $$ begin
  execute format('grant connect on database %I to lp_app', current_database());
end $$;

-- migrate:down
drop function if exists lp_current_tenant_id();
drop view if exists v_channel_batch_stats;
drop table if exists export_jobs cascade;
drop table if exists notifications_outbox cascade;
drop table if exists audit_events cascade;
drop table if exists idempotency_keys cascade;
drop table if exists events cascade;
drop table if exists webhook_deliveries cascade;
drop table if exists webhook_endpoints cascade;
drop table if exists api_keys cascade;
drop table if exists revocation_requests cascade;
drop table if exists renewals cascade;
drop table if exists client_tokens cascade;
drop table if exists license_activations cascade;
drop table if exists devices cascade;
drop table if exists licenses cascade;
drop table if exists end_customers cascade;
drop table if exists license_batches cascade;
drop table if exists channels cascade;
drop table if exists policies cascade;
drop table if exists product_features cascade;
drop table if exists product_versions cascade;
drop table if exists products cascade;
drop table if exists refresh_tokens cascade;
drop table if exists user_roles cascade;
drop table if exists role_permissions cascade;
drop table if exists roles cascade;
drop table if exists users cascade;
drop table if exists tenants cascade;
drop role if exists lp_app;
