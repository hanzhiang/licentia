/**
 * 码字符集: 31 字符(素数, 供 damm32 准群取模), 剔除易混淆的 I/L/O/U.
 * 用户录入混淆映射: O->0, I->1, L->1, U->V.
 */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ALPHABET_LEN = ALPHABET.length; // 31

const CHAR_TO_VALUE = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) CHAR_TO_VALUE.set(ALPHABET[i]!, i);

export function charToValue(c: string): number | undefined {
  return CHAR_TO_VALUE.get(c);
}

export const CONFUSABLE_MAP: Record<string, string> = {
  O: '0',
  I: '1',
  L: '1',
  U: 'V',
};

export function mapConfusables(s: string): string {
  return s
    .split('')
    .map((c) => CONFUSABLE_MAP[c] ?? c)
    .join('');
}
