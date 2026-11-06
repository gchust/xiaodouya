import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsE2e } from './ci-changes.mjs';

for (const file of [
  'apps/mobile/src/screens/TodayScreen.tsx',
  'apps/mobile/app.config.ts',
  'apps/mobile/plugins/with-latest-intent.js',
  'packages/shared/src/index.ts',
  'apps/server/src/index.ts',
  'apps/server/.env.example',
  'e2e/flows/01_onboarding.yaml',
  'e2e/groups.json',
  'e2e/verify-uploads.mjs',
  'e2e/helpers/mom-joins.js',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'tsconfig.base.json',
  '.mise.toml',
  'scripts/android-build.sh',
  'scripts/e2e-build-env.sh',
  'scripts/apk-key.mjs',
  'scripts/env.sh',
  'scripts/e2e.sh',
  'scripts/e2e-groups.mjs',
  'scripts/ci-changes.mjs',
  'scripts/dismiss-anr.sh',
  'scripts/install-maestro.sh',
  'deploy/docker-compose.dev.yml',
  'deploy/dev/s3.json',
  '.github/workflows/ci.yml',
  // 名单之外的新东西默认要跑。
  'scripts/something-new.sh',
  'tools/new-dir/file.txt',
  'Makefile',
]) {
  test(`改 ${file} 要跑`, () => {
    assert.equal(needsE2e([file]).e2e, true);
  });
}

for (const file of [
  '.github/workflows/deploy-backend.yml',
  '.github/workflows/share-page.yml',
  '.github/workflows/backup.yml',
  '.github/workflows/maintenance.yml',
  '.github/workflows/release.yml',
  'deploy/server.Dockerfile',
  'deploy/docker-compose.prod.yml',
  'deploy/Caddyfile',
  'supabase/config.toml',
  'apps/share-web/src/index.ts',
  'scripts/build-edge.mjs',
  'scripts/android-signing.mjs',
  'scripts/check-i18n.mjs',
  'docs/PROGRESS.md',
  'AGENTS.md',
  'e2e/README.md',
  'biome.json',
]) {
  test(`只改 ${file} 跳过`, () => {
    assert.equal(needsE2e([file]).e2e, false);
  });
}

test('混了一个要跑的文件就要跑', () => {
  const { e2e, why } = needsE2e(['docs/PROGRESS.md', 'apps/mobile/index.ts', 'biome.json']);
  assert.equal(e2e, true);
  assert.match(why, /apps\/mobile\/index\.ts/);
});

test('取不到改动列表时要跑，不能当成没改', () => {
  assert.equal(needsE2e([]).e2e, true);
});

test('名字相近的文件不会被误放过', () => {
  assert.equal(needsE2e(['.github/workflows/ci.yml.bak/x']).e2e, true);
  assert.equal(needsE2e(['scripts/build-edge.mjs.orig']).e2e, true);
  assert.equal(needsE2e(['docsx/a.ts']).e2e, true);
  assert.equal(needsE2e(['deploy/dev/s3.json']).e2e, true);
});

for (const file of [
  'scripts/release-plan.mjs',
  'scripts/release-plan.test.mjs',
  'scripts/release-apk.mjs',
  'scripts/release-apk.test.mjs',
]) {
  test(`只改发版脚本 ${file} 跳过`, () => {
    assert.equal(needsE2e([file]).e2e, false);
  });
}

test('发版脚本名字相近的不放过', () => {
  assert.equal(needsE2e(['scripts/release-plan.sh']).e2e, true);
  // E2E 的假发布（e2e/helpers/fake-release.sh）用它。
  assert.equal(needsE2e(['scripts/publish-apk.sh']).e2e, true);
});
