import { describe, expect, it } from 'vitest';
import { checkPassword } from './password-policy';

describe('password policy', () => {
  it('accepts a strong password', () => {
    expect(checkPassword('Tundra-42-Violet').ok).toBe(true);
  });

  it('rejects short passwords', () => {
    const r = checkPassword('Ab1!xyz');
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('至少 10 位');
  });

  it('requires three character classes', () => {
    const r = checkPassword('alllowercase');
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('至少三类');
  });

  it('rejects common passwords regardless of case and trailing digits', () => {
    expect(checkPassword('Password123').ok).toBe(false);
    expect(checkPassword('Passw0rd123').ok).toBe(false);
    expect(checkPassword('P@ssw0rd2026').ok).toBe(false);
  });

  it('rejects the email local part inside the password', () => {
    const r = checkPassword('Rylanx-2026-key', { email: 'rylanx@126.com' });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('邮箱账号名');
  });

  it('ignores short email local parts', () => {
    expect(checkPassword('Ab-cd-2026x', { email: 'ab@x.com' }).ok).toBe(true);
  });

  it('rejects runs of the same character', () => {
    const r = checkPassword('Abc!!!!2026');
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('连续 4 个相同字符');
  });
});
