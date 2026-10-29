import { describe, expect, it } from 'vitest';
import { csvHeaders, toCsv } from './csv';

const BOM = String.fromCharCode(0xfeff);

describe('csv export', () => {
  it('writes the header in column order and prefixes a BOM', () => {
    const out = toCsv([{ a: 1, b: 2 }], [
      { key: 'b', label: '第二列' },
      { key: 'a', label: '第一列' },
    ]);
    expect(out.startsWith(BOM)).toBe(true);
    expect(out.slice(1).split('\n')[0]).toBe('第二列,第一列');
    expect(out.slice(1).split('\n')[1]).toBe('2,1');
  });

  it('quotes values with commas, quotes or newlines', () => {
    const out = toCsv(
      [{ v: 'a,b' }, { v: 'say "hi"' }, { v: 'line1\nline2' }],
      [{ key: 'v', label: 'v' }],
    );
    const lines = out.slice(1).split('\n');
    expect(lines[1]).toBe('"a,b"');
    expect(lines[2]).toBe('"say ""hi"""');
    expect(out).toContain('"line1\nline2"');
  });

  it('renders null and undefined as empty cells', () => {
    const out = toCsv([{ a: null, b: undefined, c: 0 }], [
      { key: 'a', label: 'a' },
      { key: 'b', label: 'b' },
      { key: 'c', label: 'c' },
    ]);
    expect(out.slice(1).split('\n')[1]).toBe(',,0');
  });

  it('sanitises the download filename', () => {
    const h = csvHeaders('report "2026".csv');
    expect(h['Content-Disposition']).toBe('attachment; filename="report__2026_.csv"');
  });
});
