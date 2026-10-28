import { LicenseStatus } from './license-state-machine';

export type EntitlementFailure =
  | 'LIC_REVOKED'
  | 'LIC_SUSPENDED'
  | 'LIC_EXPIRED'
  | 'LIC_STATUS_INVALID';

export type Entitlement = { valid: true } | { valid: false; reason: EntitlementFailure };

export interface EntitlementInput {
  status: LicenseStatus;
  expiresAt: Date | null;
}

/**
 * 惰性权益计算: 心跳/校验路径即使扫描任务未跑, 也按当前时间判过期.
 * 永久许可 expiresAt === null 永不过期.
 */
export function computeEntitlement(l: EntitlementInput, now: Date = new Date()): Entitlement {
  switch (l.status) {
    case 'revoked':
      return { valid: false, reason: 'LIC_REVOKED' };
    case 'suspended':
      return { valid: false, reason: 'LIC_SUSPENDED' };
    case 'issued':
      return { valid: false, reason: 'LIC_STATUS_INVALID' };
    case 'expired':
      return { valid: false, reason: 'LIC_EXPIRED' };
    case 'activated':
      if (l.expiresAt !== null && l.expiresAt.getTime() <= now.getTime()) {
        return { valid: false, reason: 'LIC_EXPIRED' };
      }
      return { valid: true };
  }
}
