-- migrate:up
-- IAM 权限点补齐(0002 基础上): 读权限覆盖管理角色, 审计读取, webhook 管理
insert into role_permissions (role_code, perm) values
  ('tenant_admin', 'license:read'),
  ('tenant_admin', 'audit:read'),
  ('tenant_admin', 'webhook:write'),
  ('tenant_admin', 'batch:read'),
  ('operator',     'license:read'),
  ('operator',     'batch:read'),
  ('support',      'batch:read'),
  ('finance',      'batch:read'),
  ('finance',      'license:read')
on conflict do nothing;

-- migrate:down
delete from role_permissions where
  (role_code = 'tenant_admin' and perm in ('license:read','audit:read','webhook:write','batch:read'))
  or (role_code = 'operator' and perm in ('license:read','batch:read'))
  or (role_code = 'support' and perm = 'batch:read')
  or (role_code = 'finance' and perm in ('batch:read','license:read'));
