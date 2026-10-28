-- migrate:up
-- 审计表按月分区, 0001 只预建到 2027-01; 不补齐的话到期后所有写审计的操作都会失败。
-- 这里一次补到 2028-12, 更远的月份由 `pnpm db:partitions` 定期补齐。
create table if not exists audit_events_2027_02 partition of audit_events
  for values from ('2027-02-01') to ('2027-03-01');
create table if not exists audit_events_2027_03 partition of audit_events
  for values from ('2027-03-01') to ('2027-04-01');
create table if not exists audit_events_2027_04 partition of audit_events
  for values from ('2027-04-01') to ('2027-05-01');
create table if not exists audit_events_2027_05 partition of audit_events
  for values from ('2027-05-01') to ('2027-06-01');
create table if not exists audit_events_2027_06 partition of audit_events
  for values from ('2027-06-01') to ('2027-07-01');
create table if not exists audit_events_2027_07 partition of audit_events
  for values from ('2027-07-01') to ('2027-08-01');
create table if not exists audit_events_2027_08 partition of audit_events
  for values from ('2027-08-01') to ('2027-09-01');
create table if not exists audit_events_2027_09 partition of audit_events
  for values from ('2027-09-01') to ('2027-10-01');
create table if not exists audit_events_2027_10 partition of audit_events
  for values from ('2027-10-01') to ('2027-11-01');
create table if not exists audit_events_2027_11 partition of audit_events
  for values from ('2027-11-01') to ('2027-12-01');
create table if not exists audit_events_2027_12 partition of audit_events
  for values from ('2027-12-01') to ('2028-01-01');
create table if not exists audit_events_2028_01 partition of audit_events
  for values from ('2028-01-01') to ('2028-02-01');
create table if not exists audit_events_2028_02 partition of audit_events
  for values from ('2028-02-01') to ('2028-03-01');
create table if not exists audit_events_2028_03 partition of audit_events
  for values from ('2028-03-01') to ('2028-04-01');
create table if not exists audit_events_2028_04 partition of audit_events
  for values from ('2028-04-01') to ('2028-05-01');
create table if not exists audit_events_2028_05 partition of audit_events
  for values from ('2028-05-01') to ('2028-06-01');
create table if not exists audit_events_2028_06 partition of audit_events
  for values from ('2028-06-01') to ('2028-07-01');
create table if not exists audit_events_2028_07 partition of audit_events
  for values from ('2028-07-01') to ('2028-08-01');
create table if not exists audit_events_2028_08 partition of audit_events
  for values from ('2028-08-01') to ('2028-09-01');
create table if not exists audit_events_2028_09 partition of audit_events
  for values from ('2028-09-01') to ('2028-10-01');
create table if not exists audit_events_2028_10 partition of audit_events
  for values from ('2028-10-01') to ('2028-11-01');
create table if not exists audit_events_2028_11 partition of audit_events
  for values from ('2028-11-01') to ('2028-12-01');
create table if not exists audit_events_2028_12 partition of audit_events
  for values from ('2028-12-01') to ('2029-01-01');

-- migrate:down
drop table if exists audit_events_2027_02;
drop table if exists audit_events_2027_03;
drop table if exists audit_events_2027_04;
drop table if exists audit_events_2027_05;
drop table if exists audit_events_2027_06;
drop table if exists audit_events_2027_07;
drop table if exists audit_events_2027_08;
drop table if exists audit_events_2027_09;
drop table if exists audit_events_2027_10;
drop table if exists audit_events_2027_11;
drop table if exists audit_events_2027_12;
drop table if exists audit_events_2028_01;
drop table if exists audit_events_2028_02;
drop table if exists audit_events_2028_03;
drop table if exists audit_events_2028_04;
drop table if exists audit_events_2028_05;
drop table if exists audit_events_2028_06;
drop table if exists audit_events_2028_07;
drop table if exists audit_events_2028_08;
drop table if exists audit_events_2028_09;
drop table if exists audit_events_2028_10;
drop table if exists audit_events_2028_11;
drop table if exists audit_events_2028_12;
