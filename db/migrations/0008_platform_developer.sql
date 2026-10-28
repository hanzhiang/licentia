-- migrate:up
-- 两级治理模型(取代原来的「单租户管理台 + super_admin 跨租户逃逸口」):
--
--   平台层  platform_admin   只管理"开发者账号"(= 租户)，不碰租户内部业务数据
--   开发者层 developer_*     每个开发者 = 一个租户，自己管应用、发码、加成员
--
-- 关键约束: platform_admin 不授予任何租户业务权限(product/policy/license/...)，
-- 且这类账号的 users.tenant_id 恒为 NULL —— 租户业务接口靠 requireTenantId 直接拒绝。

insert into roles (id, code, name) values
  ('aaaaaaa2-0000-4000-8000-000000000001', 'platform_admin',    '平台管理员'),
  ('aaaaaaa2-0000-4000-8000-000000000002', 'developer_owner',   '开发者(所有者)'),
  ('aaaaaaa2-0000-4000-8000-000000000003', 'developer_operator','开发者-运营'),
  ('aaaaaaa2-0000-4000-8000-000000000004', 'developer_support', '开发者-客服'),
  ('aaaaaaa2-0000-4000-8000-000000000005', 'developer_finance', '开发者-财务'),
  ('aaaaaaa2-0000-4000-8000-000000000006', 'developer_partner', '开发者-渠道')
on conflict (code) do nothing;

insert into role_permissions (role_code, perm) values
  -- 平台层: 只有开发者账号的读/写/停用，没有任何业务权限
  ('platform_admin', 'platform:developer:read'),
  ('platform_admin', 'platform:developer:write'),
  ('platform_admin', 'platform:developer:suspend'),

  -- 开发者所有者: 本租户内全部业务 + 成员管理
  ('developer_owner', 'product:write'),
  ('developer_owner', 'policy:write'),
  ('developer_owner', 'channel:write'),
  ('developer_owner', 'license:issue'),
  ('developer_owner', 'license:read'),
  ('developer_owner', 'license:renew'),
  ('developer_owner', 'license:revoke:approve'),
  ('developer_owner', 'device:release'),
  ('developer_owner', 'end_customer:write'),
  ('developer_owner', 'report:read'),
  ('developer_owner', 'audit:read'),
  ('developer_owner', 'apikey:write'),
  ('developer_owner', 'apikey:read'),
  ('developer_owner', 'webhook:write'),
  ('developer_owner', 'batch:read'),
  ('developer_owner', 'member:read'),
  ('developer_owner', 'member:write'),

  ('developer_operator', 'license:issue'),
  ('developer_operator', 'license:read'),
  ('developer_operator', 'license:renew'),
  ('developer_operator', 'license:revoke:approve'),
  ('developer_operator', 'channel:write'),
  ('developer_operator', 'end_customer:write'),
  ('developer_operator', 'batch:read'),

  ('developer_support', 'license:read'),
  ('developer_support', 'device:release'),
  ('developer_support', 'batch:read'),

  ('developer_finance', 'license:read'),
  ('developer_finance', 'report:read'),
  ('developer_finance', 'audit:read'),
  ('developer_finance', 'batch:read'),

  ('developer_partner', 'license:issue'),
  ('developer_partner', 'license:read'),
  ('developer_partner', 'batch:read')
on conflict do nothing;

-- 清理旧模型: 先断引用再删角色，避免外键报错
delete from user_roles
 where role_code in ('super_admin','tenant_admin','operator','support','finance','partner');
delete from role_permissions
 where role_code in ('super_admin','tenant_admin','operator','support','finance','partner');
delete from roles
 where code in ('super_admin','tenant_admin','operator','support','finance','partner');

-- 审计主体类型要能装下新角色，否则新账号第一次写审计就会撞 CHECK 约束。
-- 保留旧取值: 历史数据可能仍在，且业务代码里的类型断言继续有效。
alter table audit_events drop constraint if exists audit_events_actor_type_check;
alter table audit_events add constraint audit_events_actor_type_check
  check (actor_type in (
    'platform_admin','developer_owner','developer_operator','developer_support',
    'developer_finance','developer_partner',
    'super_admin','tenant_admin','operator','support','finance',
    'end_customer','api_key','system'
  ));

-- migrate:down
insert into roles (id, code, name) values
  ('aaaaaaa1-0000-4000-8000-000000000001', 'super_admin',  '平台超级管理员'),
  ('aaaaaaa1-0000-4000-8000-000000000002', 'tenant_admin', '租户管理员'),
  ('aaaaaaa1-0000-4000-8000-000000000003', 'operator',     '产品运营'),
  ('aaaaaaa1-0000-4000-8000-000000000004', 'support',      '客服'),
  ('aaaaaaa1-0000-4000-8000-000000000005', 'finance',      '财务/审计'),
  ('aaaaaaa1-0000-4000-8000-000000000007', 'partner',      '渠道发码账号')
on conflict (code) do nothing;

insert into role_permissions (role_code, perm) values
  ('super_admin', '*'),
  ('tenant_admin', 'product:write'), ('tenant_admin', 'policy:write'),
  ('tenant_admin', 'license:issue'), ('tenant_admin', 'license:renew'),
  ('tenant_admin', 'license:revoke:approve'), ('tenant_admin', 'device:release'),
  ('tenant_admin', 'report:read'), ('tenant_admin', 'apikey:write'),
  ('operator', 'license:issue'), ('operator', 'license:renew'),
  ('operator', 'license:revoke:approve'), ('operator', 'channel:write'),
  ('support', 'license:read'), ('support', 'device:release'),
  ('finance', 'report:read'), ('finance', 'audit:read'),
  ('partner', 'license:issue'), ('partner', 'license:read'), ('partner', 'batch:read')
on conflict do nothing;

delete from user_roles
 where role_code in ('platform_admin','developer_owner','developer_operator',
                     'developer_support','developer_finance','developer_partner');
delete from role_permissions
 where role_code in ('platform_admin','developer_owner','developer_operator',
                     'developer_support','developer_finance','developer_partner');
delete from roles
 where code in ('platform_admin','developer_owner','developer_operator',
                'developer_support','developer_finance','developer_partner');
