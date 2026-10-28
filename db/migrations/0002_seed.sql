-- migrate:up
-- 固定 UUID(与 .env.example 的 ADMIN_DEV_TENANT_ID 一致), 供骨架开发/冒烟使用
-- tenant=demo: 11111111-1111-4111-8111-111111111111
-- product=dorm-check: 22222222-2222-4222-8222-222222222222
-- policy=std-365-5dev: 33333333-3333-4333-8333-333333333333
-- channel=default: 44444444-4444-4444-8444-444444444444

insert into roles (id, code, name) values
  ('aaaaaaa1-0000-4000-8000-000000000001', 'super_admin',  '平台超级管理员'),
  ('aaaaaaa1-0000-4000-8000-000000000002', 'tenant_admin', '租户管理员'),
  ('aaaaaaa1-0000-4000-8000-000000000003', 'operator',     '产品运营'),
  ('aaaaaaa1-0000-4000-8000-000000000004', 'support',      '客服'),
  ('aaaaaaa1-0000-4000-8000-000000000005', 'finance',      '财务/审计'),
  ('aaaaaaa1-0000-4000-8000-000000000006', 'developer',    '开发者');

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
  ('developer', 'apikey:read');

insert into tenants (id, code, name, status, plan)
values ('11111111-1111-4111-8111-111111111111', 'demo', '演示租户(宿舍查寝)', 'active', 'standard');

insert into products (id, tenant_id, code, name, status)
values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
        'dorm-check', '宿舍查寝系统-学校版', 'active');

insert into product_versions (id, product_id, version, status)
values ('b2222222-0000-4000-8000-000000000001',
        '22222222-2222-4222-8222-222222222222', '2.4.1', 'supported');

insert into product_features (id, product_id, code, name) values
  ('c2222222-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'dorm',  '查寝'),
  ('c2222222-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'leave', '请假');

insert into policies (
  id, tenant_id, product_id, code, name, kind, duration_days, device_limit,
  seat_limit, concurrency_limit, features, offline_window_days, heartbeat_hours,
  grace_hours, activate_within_days, allow_renewal, renew_window_days, min_version,
  status, created_by
) values (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'std-365-5dev', '标准版 365天/5设备', 'standard', 365, 5,
  null, null, '["dorm","leave"]'::jsonb, 7, 24,
  72, 0, true, 90, '>=2.0.0',
  'active', '00000000-0000-0000-0000-000000000000'
);

insert into channels (id, tenant_id, code, name, status)
values ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111',
        'default', '直销', 'active');

-- migrate:down
delete from role_permissions;
delete from user_roles;
delete from roles;
delete from product_features where product_id = '22222222-2222-4222-8222-222222222222';
delete from product_versions where product_id = '22222222-2222-4222-8222-222222222222';
delete from policies where tenant_id = '11111111-1111-4111-8111-111111111111';
delete from channels where tenant_id = '11111111-1111-4111-8111-111111111111';
delete from products where tenant_id = '11111111-1111-4111-8111-111111111111';
delete from tenants where id = '11111111-1111-4111-8111-111111111111';
