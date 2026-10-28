// k6 开放 API 校验压测(设计文档 §6.1/§17 P5).
// 用法:
//   BASE=http://localhost:3003 API_KEY=lpk_live_... CODE=D0RM-XXXX-... k6 run test/load/validate.js
// 基线阈值(骨架本机): p95<200ms, 错误率<0.1%; 生产 5000 QPS 目标在独立压测环境执行.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '2m', target: 200 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.001'],
  },
};

const BASE = __ENV.BASE || 'http://localhost:3003';
const API_KEY = __ENV.API_KEY || '';
const CODE = __ENV.CODE || '';

export default function (): void {
  const res = http.post(
    `${BASE}/open/v1/validate`,
    JSON.stringify({ code: CODE }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
    },
  );
  check(res, {
    'status is 200': (r) => r.status === 200,
    'valid flag present': (r) => JSON.parse(r.body as string).data.valid !== undefined,
  });
}
