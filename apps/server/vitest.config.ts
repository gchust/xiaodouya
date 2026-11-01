import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 所有测试共用一个真实数据库，串行避免互相清表。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
