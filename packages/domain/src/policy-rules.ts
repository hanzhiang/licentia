export interface PolicyInput {
  kind: 'trial' | 'standard' | 'perpetual' | 'subscription' | 'floating';
  durationDays: number | null;
  deviceLimit: number;
  seatLimit: number | null;
  concurrencyLimit: number | null;
  features: string[];
  offlineWindowDays: number;
  allowRenewal: boolean;
}

/** 策略字段组合校验(设计文档 §5.1 约束规则), 返回错误列表(空数组=合法) */
export function validatePolicy(p: PolicyInput): string[] {
  const errors: string[] = [];
  if (p.durationDays === null && p.kind !== 'perpetual') {
    errors.push('duration_days=null 仅允许 perpetual');
  }
  if (p.durationDays !== null && p.kind === 'perpetual') {
    errors.push('perpetual 不允许设置 duration_days');
  }
  if (p.kind === 'trial') {
    if (p.durationDays === null || p.durationDays > 30) errors.push('trial 时长必须 ≤30 天');
    if (p.allowRenewal) errors.push('trial 禁止续期');
    if (p.deviceLimit > 3) errors.push('trial 设备数必须 ≤3');
  }
  if (p.kind === 'floating' && p.concurrencyLimit === null) {
    errors.push('floating 必须设置 concurrency_limit');
  }
  if (
    p.concurrencyLimit !== null &&
    p.seatLimit !== null &&
    p.concurrencyLimit > p.seatLimit
  ) {
    errors.push('concurrency_limit 不能大于 seat_limit');
  }
  if (p.features.length === 0) errors.push('features 不能为空');
  if (new Set(p.features).size !== p.features.length) errors.push('features 存在重复项');
  if (p.offlineWindowDays < 0 || p.offlineWindowDays > 90) {
    errors.push('offline_window_days 取值 0-90');
  }
  return errors;
}
