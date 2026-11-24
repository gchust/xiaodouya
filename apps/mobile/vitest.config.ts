import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 小工具的布局（widgets/views.tsx）是 JSX，测试里直接调用它；和 Metro 一样用自动的 JSX 运行时。
  esbuild: { jsx: 'automatic' },
  test: { include: ['test/**/*.test.ts'] },
});
