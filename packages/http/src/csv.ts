/**
 * CSV 导出(给报表、审计、批次导出复用).
 *
 * 三个地方各自手拼过一遍字符串: 引号/逗号/换行的场景没人处理, 字段里一旦有逗号
 * 就会整列错位。这里统一转义, 并带 BOM 让 Excel 直接认 UTF-8。
 */
export interface CsvColumn {
  key: string;
  label: string;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  const raw = String(value);
  // 逗号、引号、换行、回车 都要包起来; 引号本身翻倍
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

/** 生成带 BOM 的 CSV 文本; columns 决定列顺序与表头 */
export function toCsv(rows: ReadonlyArray<Record<string, unknown>>, columns: CsvColumn[]): string {
  const head = columns.map((c) => cell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => cell(r[c.key])).join(','));
  const lines = [head, ...body].join('\n');
  return String.fromCharCode(0xfeff) + lines + String.fromCharCode(10);
}

/** 附件下载头: 文件名做安全裁剪, 避免引号/换行破坏响应头 */
export function csvHeaders(filename: string): Record<string, string> {
  const safe = filename.replace(/[^\w.\-一-龥]/g, '_');
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safe}"`,
  };
}
