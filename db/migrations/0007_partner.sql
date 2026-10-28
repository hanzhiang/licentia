-- migrate:up
insert into roles (id, code, name) values
  ('aaaaaaa1-0000-4000-8000-000000000007', 'partner', '渠道发码账号')
on conflict (code) do nothing;

insert into role_permissions (role_code, perm) values
  ('partner', 'license:issue'),
  ('partner', 'license:read'),
  ('partner', 'batch:read')
on conflict do nothing;

-- migrate:down
delete from role_permissions where role_code = 'partner';
delete from user_roles where role_code = 'partner';
delete from roles where code = 'partner';
