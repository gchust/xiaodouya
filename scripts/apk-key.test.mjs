import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeKey, INPUT_PATHS, inKey } from './apk-key.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const BASE_ENV = { PATH: process.env.PATH };
let repo;

/** 只给临时仓库造键用到的文件，不复制整个工作区。 */
before(() => {
  repo = mkdtempSync(join(tmpdir(), 'apk-key-'));
  const files = [
    'apps/mobile/app.config.ts',
    'apps/mobile/src/screen.tsx',
    'packages/shared/src/index.ts',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    'tsconfig.base.json',
    '.mise.toml',
    'scripts/android-build.sh',
    'scripts/env.sh',
    'scripts/apk-key.mjs',
    'apps/server/src/index.ts',
    'e2e/flows/01.yaml',
    'docs/PROGRESS.md',
    '.github/workflows/ci.yml',
  ];
  for (const file of files) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), `${file}\n`);
  }
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'scripts/e2e-build-env.sh'), join(repo, 'scripts/e2e-build-env.sh'));
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
});
after(() => rmSync(repo, { recursive: true, force: true }));

/** 改一个文件，算一次键，再改回来。 */
function keyAfterChanging(file) {
  const path = join(repo, file);
  const original = readFileSync(path);
  appendFileSync(path, '# changed\n');
  git(repo, 'add', '-A');
  const { key } = computeKey(repo, BASE_ENV);
  writeFileSync(path, original);
  git(repo, 'add', '-A');
  return key;
}

test('同样的内容和环境，键不变', () => {
  assert.equal(computeKey(repo, BASE_ENV).key, computeKey(repo, BASE_ENV).key);
});

for (const file of [
  'apps/mobile/src/screen.tsx',
  'apps/mobile/app.config.ts',
  'packages/shared/src/index.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'tsconfig.base.json',
  '.mise.toml',
  'scripts/android-build.sh',
  'scripts/env.sh',
  'scripts/e2e-build-env.sh',
  'scripts/apk-key.mjs',
]) {
  test(`改 ${file} 要换键`, () => {
    assert.notEqual(keyAfterChanging(file), computeKey(repo, BASE_ENV).key);
  });
}

for (const file of [
  'apps/server/src/index.ts',
  'e2e/flows/01.yaml',
  'docs/PROGRESS.md',
  '.github/workflows/ci.yml',
]) {
  test(`改 ${file} 不用重新构建`, () => {
    assert.equal(keyAfterChanging(file), computeKey(repo, BASE_ENV).key);
  });
}

test('新增 App 文件要换键', () => {
  const old = computeKey(repo, BASE_ENV).key;
  writeFileSync(join(repo, 'apps/mobile/src/new.ts'), 'x');
  git(repo, 'add', '-A');
  assert.notEqual(computeKey(repo, BASE_ENV).key, old);
  rmSync(join(repo, 'apps/mobile/src/new.ts'));
  git(repo, 'add', '-A');
});

test('文件权限变了要换键', () => {
  const old = computeKey(repo, BASE_ENV).key;
  chmodSync(join(repo, 'scripts/env.sh'), 0o755);
  git(repo, 'add', '-A');
  assert.notEqual(computeKey(repo, BASE_ENV).key, old);
  chmodSync(join(repo, 'scripts/env.sh'), 0o644);
  git(repo, 'add', '-A');
});

for (const name of [
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_SHARE_BASE_URL',
  'EXPO_PUBLIC_API_REGION',
  'EXPO_PUBLIC_TERMS_URL',
  'EXPO_PUBLIC_SOMETHING_NEW',
  'APP_VERSION',
  'ANDROID_ARCHS',
  'NODE_VERSION',
  'JAVA_VERSION',
]) {
  test(`环境变量 ${name} 进了键`, () => {
    const changed = computeKey(repo, { ...BASE_ENV, [name]: 'changed' }).key;
    assert.notEqual(changed, computeKey(repo, BASE_ENV).key);
  });
}

test('无关的环境变量不影响键（否则每次都换键，缓存没用）', () => {
  const changed = computeKey(repo, { ...BASE_ENV, GITHUB_SHA: 'abc', GRADLE_HEAP: '6g' }).key;
  assert.equal(changed, computeKey(repo, BASE_ENV).key);
});

test('e2e-build-env.sh 里的默认值是键的一部分', () => {
  const { buildEnv } = computeKey(repo, BASE_ENV);
  assert.match(buildEnv, /^EXPO_PUBLIC_E2E=1$/m);
  assert.match(buildEnv, /^EXPO_PUBLIC_API_URL=http:\/\/10\.0\.2\.2:8787$/m);
  assert.match(buildEnv, /^EXPO_PUBLIC_SHARE_BASE_URL=https:\/\/share\.example\.test$/m);
  assert.match(buildEnv, /^ANDROID_ARCHS=x86_64$/m);
});

/** 列出 dir 下所有源文件，跳过依赖和生成的原生工程。 */
function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'android' || name === 'ios') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|js|jsx|mjs|cjs|kt|gradle)$/.test(name) ? [path] : [];
  });
}

test('App 读的每个环境变量都进了键', () => {
  const mobile = join(ROOT, 'apps/mobile');
  const names = new Set();
  for (const file of sources(mobile)) {
    if (file.startsWith(join(mobile, 'test'))) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) {
      names.add(match[1]);
    }
  }
  assert.ok(names.has('EXPO_PUBLIC_API_URL'), '扫描没有找到 EXPO_PUBLIC_API_URL，扫描本身坏了');
  assert.deepEqual([...names].filter((name) => !inKey(name)).sort(), []);
});

test('构建脚本设置的环境变量都进了键', () => {
  const script = readFileSync(join(ROOT, 'scripts/e2e-build-env.sh'), 'utf8');
  const exported = [...script.matchAll(/^export ([A-Z0-9_]+)=/gm)].map((match) => match[1]);
  assert.ok(exported.length > 0);
  assert.deepEqual(
    exported.filter((name) => !inKey(name)),
    [],
  );
});

test('App 依赖的工作区包都在输入里', () => {
  const { dependencies, devDependencies } = JSON.parse(
    readFileSync(join(ROOT, 'apps/mobile/package.json'), 'utf8'),
  );
  const workspace = Object.entries({ ...dependencies, ...devDependencies })
    .filter(([, version]) => version.startsWith('workspace:'))
    .map(([name]) => name);
  assert.deepEqual(workspace, ['@xiaodouya/shared']);
  assert.ok(INPUT_PATHS.includes('packages/shared'));
});
