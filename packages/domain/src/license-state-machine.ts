import { AppError } from './errors';

/**
 * 授权码状态机(设计文档 §5.2).
 * 合法迁移穷举; 非法迁移一律抛 LIC_STATUS_INVALID.
 * activated -> activated 仅用于续期延长(心跳不改变状态).
 */
export type LicenseStatus = 'issued' | 'activated' | 'suspended' | 'revoked' | 'expired';

export const LICENSE_TRANSITIONS: Record<LicenseStatus, LicenseStatus[]> = {
  issued: ['activated', 'revoked', 'expired'],
  activated: ['activated', 'suspended', 'revoked', 'expired'],
  suspended: ['activated', 'revoked'],
  revoked: [],
  expired: ['activated', 'revoked'],
};

export function canTransition(from: LicenseStatus, to: LicenseStatus): boolean {
  return LICENSE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: LicenseStatus, to: LicenseStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError('LIC_STATUS_INVALID', `illegal transition: ${from} -> ${to}`);
  }
}

/** 将状态映射为客户端可见的 4xx/5xx 语义错误(激活/心跳/校验路径专用) */
export function statusError(status: LicenseStatus): AppError {
  switch (status) {
    case 'revoked':
      return new AppError('LIC_REVOKED');
    case 'expired':
      return new AppError('LIC_EXPIRED');
    case 'suspended':
      return new AppError('LIC_SUSPENDED');
    case 'issued':
      return new AppError('LIC_STATUS_INVALID', '授权码尚未激活');
    case 'activated':
      // 理论上不应到达; 激活态的失败由 expires_at 判定
      return new AppError('LIC_STATUS_INVALID');
  }
}
