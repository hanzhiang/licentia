import { defineConfig } from 'vitest/config';
import path from 'node:path';

const root = path.resolve(__dirname);

export default defineConfig({
  resolve: {
    alias: [
      // 单测/集成测试直接引用各包源码, 不依赖 tsc 构建产物
      {
        find: /^@lp\/(.+)$/,
        replacement: path.join(root, 'packages', '$1', 'src', 'index.ts'),
      },
    ],
  },
  test: {
    include: [
      'packages/*/src/**/*.spec.ts',
      'apps/*/src/**/*.spec.ts',
      'sdks/*/src/**/*.spec.ts',
      'test/e2e/**/*.spec.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // e2e 依赖 demo 租户/产品/策略/账号, 每次跑测试前幂等重建(数据可能被 db:reset 清空)
    globalSetup: ['test/e2e/global-setup.ts'],
    // e2e 共享同一个开发库, 测试文件必须串行(内部用例按顺序执行)
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
