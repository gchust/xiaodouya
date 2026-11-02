#!/usr/bin/env node
// E2E APK 的缓存键：决定“这份代码能不能复用已经构建好的 APK”。
// 键漏掉一个输入，就会测到旧代码还显示全绿，这比慢更糟。所以：
//   - 输入按路径整体算，不挑文件：apps/mobile 改什么都重新构建，宁可多构建。
//   - 环境变量不靠手抄：EXPO_PUBLIC_* 从 e2e-build-env.sh 执行后的环境里全部取。
//   - apk-key.test.mjs 扫描源码，App 读的 process.env 不在键里就失败，还会逐类改输入确认键变了。
//   - main 上每次都重新构建并和缓存里的比（compare-apk.sh），键漏了输入会在那里暴露。
// 用法：node scripts/apk-key.mjs [--explain]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 改了这些路径（内容或文件权限）就要重新构建。 */
export const INPUT_PATHS = [
  'apps/mobile',
  'packages/shared',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'tsconfig.base.json',
  '.mise.toml',
  'scripts/android-build.sh',
  'scripts/e2e-build-env.sh',
  'scripts/env.sh',
  'scripts/apk-key.mjs',
];

/** 不是 EXPO_PUBLIC_ 开头、但会改变包内容的环境变量。工具版本由 CI 传入。 */
export const BUILD_ENV = [
  'ANDROID_ALLOW_HTTP',
  'ANDROID_ARCHS',
  'ANDROID_PACKAGE',
  'APP_VERSION',
  'APP_VERSION_CODE',
  'EAS_PROJECT_ID',
  'GOOGLE_SERVICES_JSON',
  'IOS_BUNDLE_ID',
  'JAVA_VERSION',
  'NODE_VERSION',
];

export const inKey = (name) => name.startsWith('EXPO_PUBLIC_') || BUILD_ENV.includes(name);

/** 算出键和它的全部输入。root 是仓库根目录，env 是构建时的环境。 */
export function computeKey(root, env = process.env) {
  // git ls-files -s 给的是每个文件内容的 blob 哈希，不用自己读文件。
  const files = execFileSync('git', ['ls-files', '-s', '--', ...INPUT_PATHS], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (files.trim() === '') throw new Error(`在 ${root} 里找不到 APK 的输入文件`);
  // 让 bash 执行一遍，得到的才是构建时真实生效的值（包括默认值）。
  const dump = execFileSync('bash', ['-c', 'source scripts/e2e-build-env.sh && env -0'], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const buildEnv = dump
    .split('\0')
    .filter((line) => inKey(line.split('=')[0]))
    .sort()
    .join('\n');
  const hash = createHash('sha256').update(files).update('\0').update(buildEnv).digest('hex');
  return { key: hash.slice(0, 40), files, buildEnv };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { key, files, buildEnv } = computeKey(root);
  if (process.argv.includes('--explain')) {
    console.error(`${files.trim().split('\n').length} 个输入文件`);
    console.error(buildEnv);
  }
  console.log(key);
}
