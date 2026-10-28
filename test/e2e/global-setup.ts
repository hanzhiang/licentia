/**
 * e2e 全局夹具: 保证测试依赖的 demo 租户/产品/策略/渠道/账号存在。
 *
 * 数据可能被 `pnpm db:reset` 清空，而 e2e 用例引用固定的 demo UUID；
 * 这里复用 `pnpm seed:demo` 的同一份实现幂等重建。未设置 TEST_DATABASE_URL 时跳过。
 */
import { seedDemoFixtures } from '../../packages/db/src/bin/seed-demo';

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  await seedDemoFixtures(url, process.env.SEED_PASSWORD ?? 'Passw0rd!demo');
}
