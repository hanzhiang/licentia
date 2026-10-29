/**
 * 结构化日志.
 *
 * 之前全仓 80+ 处 console.* 直接拼字符串: 多进程混在一个终端时无法区分来源,
 * 也没有级别过滤与机器可读字段, 采集端只能靠正则抠。
 *
 * 默认输出人类可读的一行; 设置 LOG_FORMAT=json 后输出 JSON Lines,
 * 便于 Loki/ELK 直接解析。LOG_LEVEL 控制最低级别。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let serviceName = process.env.LP_SERVICE ?? 'app';

/** 每个进程启动时设置一次, 出现在每条日志里 */
export function setServiceName(name: string): void {
  serviceName = name;
}

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL ?? 'info') as LogLevel;
  return LEVEL_ORDER[lvl] ?? LEVEL_ORDER.info;
}

function jsonMode(): boolean {
  return (process.env.LOG_FORMAT ?? 'text') === 'json';
}

function normalize(fields: unknown): Record<string, unknown> | undefined {
  if (fields === undefined || fields === null) return undefined;
  if (typeof fields === 'object' && !Array.isArray(fields)) {
    return fields as Record<string, unknown>;
  }
  // 兼容 log.error('xxx', err.message) 这种第二参数是字符串的写法
  return { detail: fields };
}

function emit(level: LogLevel, message: string, raw?: unknown): void {
  const fields = normalize(raw);
  if (LEVEL_ORDER[level] < threshold()) return;
  const ts = new Date().toISOString();
  if (jsonMode()) {
    const line = JSON.stringify({ ts, level, service: serviceName, message, ...fields });
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    return;
  }
  const extra =
    fields && Object.keys(fields).length > 0
      ? ' ' +
        Object.entries(fields)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
      : '';
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${serviceName}] ${message}${extra}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

export const log = {
  debug: (message: string, fields?: unknown): void => emit('debug', message, fields),
  info: (message: string, fields?: unknown): void => emit('info', message, fields),
  warn: (message: string, fields?: unknown): void => emit('warn', message, fields),
  error: (message: string, fields?: unknown): void => emit('error', message, fields),
};
