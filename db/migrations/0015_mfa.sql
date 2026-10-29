-- migrate:up
-- 两步验证(TOTP): 管理员账号是整租户的入口, 只靠密码不够。
-- 密钥与其它敏感字段一样加密存储(mfa_secret_enc), 恢复码只存哈希。
alter table users add column mfa_secret_enc bytea;
alter table users add column mfa_enabled boolean not null default false;

create table mfa_recovery_codes (
  id         uuid primary key,
  user_id    uuid not null references users(id) on delete cascade,
  code_hash  bytea not null,
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, code_hash)
);

create index idx_mfa_codes_user on mfa_recovery_codes (user_id);

-- users 本身不在 0001 的 RLS 清单里(没有 tenant_id 列), 恢复码按 user_id 访问,
-- 与 users 表同等处理: 只在系统事务里按 user_id 精确读写。
grant select, insert, update, delete on mfa_recovery_codes to lp_app;

-- migrate:down
drop table if exists mfa_recovery_codes;
alter table users drop column if exists mfa_enabled;
alter table users drop column if exists mfa_secret_enc;
