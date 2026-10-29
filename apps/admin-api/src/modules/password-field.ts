import { z } from 'zod';
import { checkPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@lp/auth';

/**
 * 新设密码的 zod 校验(注册 / 创建成员 / 重置密码共用).
 *
 * 登录不套这套规则: 存量账号的旧密码可能不满足新策略, 但不应因此登不进来。
 */
export function passwordField(): z.ZodString {
  return z
    .string()
    .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`)
    .max(PASSWORD_MAX_LENGTH, `密码最长 ${PASSWORD_MAX_LENGTH} 位`);
}

/**
 * 在对象层面校验强度(需要邮箱一起判断是否包含账号名).
 * 用法: schema.superRefine((v, ctx) => refinePassword(v.password, ctx, { email: v.email }))
 */
export function refinePassword(
  password: string,
  ctx: z.RefinementCtx,
  opts: { email?: string | null } = {},
): void {
  const result = checkPassword(password, opts);
  if (!result.ok) {
    // 一次把所有问题说清楚, 别让用户改一条再被拒一条
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['password'],
      message: result.problems.join('；'),
    });
  }
}
