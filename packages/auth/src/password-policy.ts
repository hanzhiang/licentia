/**
 * 密码强度策略.
 *
 * 之前只有 zod 的 `min(8)`: `12345678`、`password` 都能注册成功。
 * 管理后台是整租户的入口, 弱口令等同于把发码权限公开。
 *
 * 规则刻意保守(不追求 NIST 的完整熵估算):
 *  - 长度 10–200
 *  - 大写/小写/数字/符号 四类里至少占三类
 *  - 不在常见弱口令表里(大小写与尾部数字不敏感)
 *  - 不含邮箱 @ 前面那段(多数人习惯把邮箱当密码)
 *  - 不出现同一字符连续 4 次以上
 *
 * 只约束**新设密码**(注册、创建成员、重置密码); 存量账号登录不受影响。
 */
export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

/** 常见弱口令: 命中即拒绝 */
const WEAK_PASSWORDS = new Set([
  'password',
  'passw0rd',
  'p@ssw0rd',
  'p@ssword',
  'pa$$word',
  'password1',
  'password123',
  'passw0rd1',
  '12345678',
  '123456789',
  '1234567890',
  '87654321',
  '111111',
  '000000',
  '123123',
  '112233',
  '666666',
  '888888',
  '88888888',
  '123qwe',
  'qwerty',
  'qwerty123',
  'qwertyuiop',
  '1q2w3e4r',
  '1qaz2wsx',
  'qazwsx',
  'zaq12wsx',
  'abc123',
  'abcd1234',
  'a1234567',
  'aa123456',
  'admin',
  'admin123',
  'admin@123',
  'root1234',
  'test1234',
  'changeme',
  'welcome',
  'welcome1',
  'letmein',
  'iloveyou',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'superman',
  'trustno1',
  'master',
  'shadow',
  'secret',
  'login',
  'licentia',
]);

const MIN_LENGTH = 10;
const MAX_LENGTH = 200;

function classesOf(pw: string): number {
  let n = 0;
  if (/[a-z]/.test(pw)) n += 1;
  if (/[A-Z]/.test(pw)) n += 1;
  if (/[0-9]/.test(pw)) n += 1;
  if (/[^a-zA-Z0-9]/.test(pw)) n += 1;
  return n;
}

export function checkPassword(
  password: string,
  opts: { email?: string | null } = {},
): PasswordCheck {
  const problems: string[] = [];

  if (password.length < MIN_LENGTH) {
    problems.push(`密码至少 ${MIN_LENGTH} 位`);
  }
  if (password.length > MAX_LENGTH) {
    problems.push(`密码最长 ${MAX_LENGTH} 位`);
  }
  if (classesOf(password) < 3) {
    problems.push('密码需包含大写字母、小写字母、数字、符号中的至少三类');
  }

  // 尾部数字与大小写不敏感: P@ssw0rd123 依然是 P@ssw0rd
  const normalized = password.toLowerCase().replace(/[0-9]+$/, '');
  if (WEAK_PASSWORDS.has(password.toLowerCase()) || WEAK_PASSWORDS.has(normalized)) {
    problems.push('密码过于常见, 请换一个');
  }

  const local = opts.email?.split('@')[0]?.trim().toLowerCase() ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local)) {
    problems.push('密码不能包含邮箱账号名');
  }

  if (/(.)\1{3,}/.test(password)) {
    problems.push('密码不能包含连续 4 个相同字符');
  }

  return { ok: problems.length === 0, problems };
}

/** 供 zod 复用的阈值, 避免前后端各写一份 */
export const PASSWORD_MIN_LENGTH = MIN_LENGTH;
export const PASSWORD_MAX_LENGTH = MAX_LENGTH;
