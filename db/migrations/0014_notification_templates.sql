-- migrate:up
-- 通知模板: 此前模板写死在代码里, 只有中文, 且后台无法查看/调整。
-- 现在每个租户可覆盖内置模板(subject/body/sms), 内置默认同时提供中英两版。
-- 租户级 locale 决定该租户发给终端客户的邮件用哪种语言。

alter table tenants add column locale text not null default 'zh-CN'
  check (locale in ('zh-CN', 'en'));

create table notification_templates (
  id          uuid primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  code        text not null,
  locale      text not null check (locale in ('zh-CN', 'en')),
  subject     text not null,
  body        text not null,
  sms_body    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (tenant_id, code, locale)
);

-- 新表不在 0001 的 RLS 循环清单里, 必须显式启用, 否则会绕过多租户隔离
alter table notification_templates enable row level security;
alter table notification_templates force row level security;
create policy tenant_isolation on notification_templates using (
  current_setting('app.bypass_rls', true) = 'on'
  or tenant_id = lp_current_tenant_id()
) with check (
  current_setting('app.bypass_rls', true) = 'on'
  or tenant_id = lp_current_tenant_id()
);

grant select, insert, update, delete on notification_templates to lp_app;

insert into role_permissions (role_code, perm) values
  ('developer_owner', 'notify:read'), ('developer_owner', 'notify:write'),
  ('developer_owner', 'tenant:read'), ('developer_owner', 'tenant:write'),
  ('developer_operator', 'notify:read'), ('developer_operator', 'notify:write'),
  ('developer_operator', 'tenant:read'),
  ('developer_support', 'notify:read'), ('developer_support', 'tenant:read'),
  ('developer_finance', 'notify:read'),
  -- 旧模型遗留的通用角色(仍可能有存量账号)
  ('developer', 'notify:read'), ('developer', 'notify:write'),
  ('developer', 'tenant:read'), ('developer', 'tenant:write')
on conflict do nothing;

-- migrate:down
delete from role_permissions where perm in
  ('notify:read', 'notify:write', 'tenant:read', 'tenant:write');
drop table if exists notification_templates;
alter table tenants drop column if exists locale;
