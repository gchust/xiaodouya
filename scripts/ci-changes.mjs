#!/usr/bin/env node
// 决定这个 PR 要不要跑 Android E2E。宁可多跑：只有全部改动都在下面的名单里才跳过，
// 名单之外的任何文件（包括将来新增的目录）默认都要跑。
// 用法：git diff --name-only 的输出接到标准输入，打印 e2e=true 或 e2e=false。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// 纯文档，和 ci.yml 的 paths-ignore（docs/**、**/*.md）一致。自动发版（release-plan.mjs）也按它判断。
export const DOCS = [/^docs\//, /\.md$/];

/** 确定不进 APK、也不影响 E2E 环境的文件。 */
const NO_APP_IMPACT = [
  ...DOCS,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.dockerignore$/,
  /^biome\.json$/,
  // ci.yml 定义了 E2E 怎么跑（模拟器、分组、构建），改了就要真跑一次才知道没弄坏。
  /^\.github\/workflows\/(?!ci\.yml$)[^/]+$/,
  // 开发用的 Compose 和 S3 配置是 E2E 的环境，其余是生产部署，服务端镜像由“服务端集成测试”构建。
  /^deploy\/(?!docker-compose\.dev\.yml$|dev\/)/,
  // Edge Function 的入口和配置，代码来自 apps/server，由 pnpm test:edge 验证。
  /^supabase\//,
  // 分享网页：App 只拿它的地址，E2E 不打开它，它自己的测试在 pnpm test 里。
  /^apps\/share-web\//,
  // 发版用的脚本只在 release.yml 和 auto-release.yml 里跑。
  /^scripts\/(adb-ui\.py|android-signing(\.test)?\.mjs|build-edge\.mjs|check-i18n\.mjs|release-(apk|plan)(\.test)?\.mjs|screenshot\.sh|subset-fonts\.py)$/,
];

/** 没有改动列表时也要跑：多半是取差异出错了，不能当成没改。 */
export function needsE2e(files) {
  if (files.length === 0) return { e2e: true, why: '没有取到改动列表' };
  const trigger = files.find((file) => !NO_APP_IMPACT.some((pattern) => pattern.test(file)));
  return trigger
    ? { e2e: true, why: `${trigger} 可能影响 App` }
    : { e2e: false, why: `${files.length} 个文件都不影响 App` };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = readFileSync(0, 'utf8').split('\n').filter(Boolean);
  const { e2e, why } = needsE2e(files);
  console.error(`${e2e ? '要跑 E2E' : '跳过 E2E'}：${why}`);
  console.log(`e2e=${e2e}`);
}
