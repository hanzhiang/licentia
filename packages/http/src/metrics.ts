/**
 * 极简 Prometheus 指标(不引入额外依赖).
 *
 * 之前只有 worker 有 /metrics, 四个 HTTP 服务完全是黑盒: 出问题时看不到 QPS、
 * 错误率和路由级延迟。这里用 Fastify 钩子聚合, 暴露文本格式供抓取。
 *
 * 只按 (method, route, status) 计数, 不记录请求体或用户标识。
 * 抓取端点本身受 METRICS_TOKEN 保护(见 metricsAccess)。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

interface Series {
  count: number;
  sumMs: number;
}

const series = new Map<string, Series>();

function key(method: string, route: string, status: number): string {
  return `${method}\u0000${route}\u0000${status}`;
}

export function observeRequest(
  method: string,
  route: string,
  status: number,
  ms: number,
): void {
  const k = key(method, route, status);
  const cur = series.get(k) ?? { count: 0, sumMs: 0 };
  cur.count += 1;
  cur.sumMs += ms;
  series.set(k, cur);
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function renderMetrics(): string {
  const lines: string[] = [
    '# HELP lp_http_requests_total HTTP 请求数',
    '# TYPE lp_http_requests_total counter',
  ];
  const dur: string[] = [
    '# HELP lp_http_request_duration_ms_sum 累计耗时(毫秒)',
    '# TYPE lp_http_request_duration_ms_sum counter',
  ];
  let total = 0;
  for (const [k, v] of series) {
    const [method, route, status] = k.split('\u0000');
    const labels = `method="${esc(method!)}",route="${esc(route!)}",status="${status}"`;
    lines.push(`lp_http_requests_total{${labels}} ${v.count}`);
    dur.push(`lp_http_request_duration_ms_sum{${labels}} ${Math.round(v.sumMs)}`);
    total += v.count;
  }
  lines.push(
    '# HELP lp_http_requests_all_total 全部请求数',
    '# TYPE lp_http_requests_all_total counter',
    `lp_http_requests_all_total ${total}`,
  );
  return [...lines, ...dur].join('\n') + '\n';
}

/** 测试用: 清空累计值 */
export function resetMetrics(): void {
  series.clear();
}

interface FastifyLike {
  addHook(name: 'onRequest', fn: (req: ReqLike, reply: unknown, done: () => void) => void): void;
  addHook(
    name: 'onResponse',
    fn: (req: ReqLike, reply: ReplyLike, done: () => void) => void,
  ): void;
  get(path: string, fn: (req: ReqLike, reply: ReplyLike) => void): void;
}

interface ReqLike {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  routerPath?: string;
  routeOptions?: { url?: string };
  _lpStart?: number;
}

interface ReplyLike {
  statusCode?: number;
  headers?: Record<string, string>;
  code?: (n: number) => ReplyLike;
  header?: (name: string, value: string) => ReplyLike;
  type?: (t: string) => ReplyLike;
  send?: (body: string) => void;
}

function headerValue(req: ReqLike, name: string): string | undefined {
  const raw = req.headers?.[name];
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
}

/** 定长比较, 避免用 === 直接比密钥带来的时序差异 */
function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * /metrics 的访问控制:
 *  - 配置了 METRICS_TOKEN: 必须带 Authorization: Bearer <token>
 *  - 未配置且 NODE_ENV=prod: 端点直接不存在(404), 不对外暴露请求量
 *  - 未配置且非生产: 开放, 方便本机 curl
 */
export function metricsAccess(req: ReqLike): 'ok' | 'unauthorized' | 'hidden' {
  const token = process.env.METRICS_TOKEN ?? '';
  if (!token) return process.env.NODE_ENV === 'prod' ? 'hidden' : 'ok';
  const header = headerValue(req, 'authorization') ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return 'unauthorized';
  return sameSecret(header.slice(prefix.length).trim(), token) ? 'ok' : 'unauthorized';
}

/**
 * 挂到 Fastify 实例上: 记录每个请求的耗时与状态码, 并暴露 GET /metrics。
 * 路由用注册路径(而非实际 URL), 避免把 id 当成指标维度导致基数爆炸。
 */
export function installMetrics(app: FastifyLike): void {
  app.addHook('onRequest', (req, _reply, done) => {
    req._lpStart = Date.now();
    done();
  });
  app.addHook('onResponse', (req, reply, done) => {
    const start = req._lpStart ?? Date.now();
    const route = req.routeOptions?.url ?? req.routerPath ?? 'unknown';
    observeRequest(
      req.method ?? 'UNKNOWN',
      route,
      reply.statusCode ?? 0,
      Date.now() - start,
    );
    done();
  });
  app.get('/metrics', (req, reply) => {
    const access = metricsAccess(req);
    if (access === 'hidden') {
      reply.code?.(404);
      reply.type?.('application/json');
      reply.send?.(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (access === 'unauthorized') {
      reply.code?.(401);
      reply.header?.('www-authenticate', 'Bearer');
      reply.type?.('application/json');
      reply.send?.(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    reply.type?.('text/plain; version=0.0.4');
    reply.send?.(renderMetrics());
  });
}
