-- migrate:up
-- 开发者注册需要邮箱验证：未验证的账号不能登录，避免脚本批量注册出"能用的空租户"。
-- 存量账号一律视为已验证（它们是在没有验证机制时由管理员/种子创建的）。
alter table users add column if not exists email_verified_at timestamptz;

update users set email_verified_at = created_at where email_verified_at is null;

-- migrate:down
alter table users drop column if exists email_verified_at;
