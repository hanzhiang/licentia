-- migrate:up
-- 安全修复: 视图默认以 owner(postgres) 权限执行, 会绕过底层表 RLS 造成跨租户泄漏.
-- PG15+ 用 security_invoker=on 让视图以调用者(lp_app)身份执行, RLS 策略正常生效.
drop view if exists v_channel_batch_stats;
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

-- migrate:down
drop view if exists v_channel_batch_stats;
create view v_channel_batch_stats as
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
