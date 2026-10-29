import http from 'node:http';
import { log } from '@lp/config';

/**
 * worker 健康端点(设计文档 §16 运维).
 *
 * worker 没有业务端口，进程是死是活此前只能靠人盯日志。这里开一个只读 HTTP 端点：
 *  - /healthz  最近一次 tick 的时间与错误，供容器/负载均衡探活
 *  - /metrics  极简 Prometheus 文本格式，至少能看出积压与节拍是否正常
 *
 * 只读、不暴露业务数据；不依赖数据库以外的任何组件。
 */
export interface WorkerHealthState {
  startedAt: number;
  lastTickAt: number | null;
  lastTickMs: number;
  ticks: number;
  lastError: string | null;
  /** 最近一次 tick 处理量，便于发现积压 */
  lastSummary: Record<string, number>;
}

export function createHealthState(): WorkerHealthState {
  return {
    startedAt: Date.now(),
    lastTickAt: null,
    lastTickMs: 0,
    ticks: 0,
    lastError: null,
    lastSummary: {},
  };
}

/** 超过该时长没有成功 tick 就视为不健康(节拍 5s, 留足余量) */
const STALE_MS = 60_000;

export function startHealthServer(
  state: WorkerHealthState,
  port: number,
  onShutdown: () => void,
): http.Server {
  const server = http.createServer((req, res) => {
    const now = Date.now();
    const stale = state.lastTickAt === null || now - state.lastTickAt > STALE_MS;

    if (req.url === '/healthz') {
      const healthy = !stale;
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: healthy,
          uptime_s: Math.floor((now - state.startedAt) / 1000),
          last_tick_at: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
          last_tick_ms: state.lastTickMs,
          ticks: state.ticks,
          stale,
          last_error: state.lastError,
          last_summary: state.lastSummary,
        }),
      );
      return;
    }

    if (req.url === '/metrics') {
      // 与 HTTP 服务同一套规则: 配了 token 才对外, 生产环境没配 token 直接不暴露
      const token = process.env.METRICS_TOKEN ?? '';
      if (token) {
        const auth = req.headers['authorization'] ?? '';
        if (auth !== `Bearer ${token}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      } else if (process.env.NODE_ENV === 'prod') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const lines = [
        '# HELP lp_worker_ticks_total 完成的 tick 次数',
        '# TYPE lp_worker_ticks_total counter',
        `lp_worker_ticks_total ${state.ticks}`,
        '# HELP lp_worker_last_tick_ms 最近一次 tick 耗时(毫秒)',
        '# TYPE lp_worker_last_tick_ms gauge',
        `lp_worker_last_tick_ms ${state.lastTickMs}`,
        '# HELP lp_worker_stale 超过 60s 未成功 tick',
        '# TYPE lp_worker_stale gauge',
        `lp_worker_stale ${stale ? 1 : 0}`,
        ...Object.entries(state.lastSummary).map(
          ([k, v]) => `lp_worker_last_${k} ${v}`,
        ),
      ];
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(lines.join('\n') + '\n');
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, '0.0.0.0', () => {
    log.info(`[worker] health on :${port} (/healthz, /metrics)`);
  });

  // 关停时先停监听，避免探活继续打到即将退出的进程
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => {
    server.close();
    onShutdown();
  });

  return server;
}
