-- migrate:up
-- 终端客户联系邮箱维护(到期提醒的收件人来源, 设计文档 §16).
-- 单独授权点: 能改联系邮箱等于能改"提醒发给谁", 不应沿用发码/续期的权限.
insert into role_permissions (role_code, perm) values
  ('tenant_admin', 'end_customer:write'),
  ('operator',     'end_customer:write')
on conflict do nothing;

-- migrate:down
delete from role_permissions where perm = 'end_customer:write';
