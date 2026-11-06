import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ciCommit,
  docsOnly,
  latestTag,
  nextVersion,
  nextVersionCode,
  planRelease,
  previousRelease,
  prsFrom,
} from './release-plan.mjs';

test('最新的标签按版本号比，不按字母', () => {
  assert.equal(latestTag(['v0.1.0', 'v0.10.0', 'v0.9.0', 'v0.3.3']), 'v0.10.0');
  assert.equal(latestTag(['v1.0.0', 'v0.99.9']), 'v1.0.0');
});

test('不是 vX.Y.Z 的标签不算', () => {
  assert.equal(latestTag(['v0.8.0', 'v0.9.0-rc1', 'v9', 'release-1', 'v1.0.0.1']), 'v0.8.0');
  assert.equal(latestTag([]), null);
});

test('默认次版本号加一', () => {
  assert.equal(nextVersion(['v0.8.0', 'v0.7.0']), 'v0.9.0');
  assert.equal(nextVersion(['v0.3.3']), 'v0.4.0');
  assert.equal(nextVersion(['v0.9.0']), 'v0.10.0');
  assert.equal(nextVersion(['v1.2.5', 'v0.20.0']), 'v1.3.0');
});

test('没有标签时从 v0.1.0 开始', () => {
  assert.equal(nextVersion([]), 'v0.1.0');
});

test('从合并提交和 squash 提交里取 PR 编号', () => {
  assert.deepEqual(
    prsFrom([
      'Merge pull request #93 from gchust/docs/release-v0.8.0',
      'feat: share memories (#88)',
      'fix: typo',
      'Merge branch main into x',
      'Merge pull request #92 from gchust/feat/family-documents',
    ]),
    [93, 88, 92],
  );
});

test('同一个 PR 只算一次', () => {
  assert.deepEqual(
    prsFrom(['Merge pull request #5 from a/b', 'Merge pull request #5 from a/b']),
    [5],
  );
});

test('只有 docs/ 和 Markdown 才算纯文档，和 ci.yml 的 paths-ignore 一致', () => {
  assert.equal(
    docsOnly(['docs/PROGRESS.md', 'README.md', 'e2e/README.md', 'docs/design/a.png']),
    true,
  );
  for (const file of [
    'deploy/Caddyfile',
    'supabase/config.toml',
    '.github/workflows/backup.yml',
    'apps/share-web/src/index.ts',
    'biome.json',
    'docsx/a.md.ts',
    'LICENSE',
  ]) {
    assert.equal(docsOnly(['docs/PROGRESS.md', file]), false, file);
  }
});

test('没有改动列表不算纯文档', () => {
  assert.equal(docsOnly([]), false);
});

test('CI 跑过的提交：从新到旧第一个不全是文档的', () => {
  const commits = [
    { sha: 'c3', files: ['docs/PROGRESS.md'] },
    { sha: 'c2', files: ['apps/mobile/a.ts', 'docs/x.md'] },
    { sha: 'c1', files: ['apps/server/b.ts'] },
  ];
  assert.equal(ciCommit(commits), 'c2');
  assert.equal(ciCommit([{ sha: 'd', files: ['README.md'] }]), null);
  // 取不到某个提交的改动列表时当它跑过 CI，不能跳过它去用更旧的。
  assert.equal(ciCommit([{ sha: 'e', files: [] }, commits[2]]), 'e');
});

const base = {
  tags: ['v0.7.0', 'v0.8.0'],
  head: 'h3',
};

test('有合并的 PR 且有代码改动：发下一个次版本', () => {
  const plan = planRelease({
    ...base,
    changed: ['apps/mobile/a.ts', 'docs/PROGRESS.md'],
    commits: [
      {
        sha: 'h3',
        subject: 'Merge pull request #95 from gchust/ci/auto-release',
        files: ['docs/PROGRESS.md'],
      },
      {
        sha: 'h2',
        subject: 'Merge pull request #94 from gchust/feat/share',
        files: ['apps/mobile/a.ts'],
      },
    ],
  });
  assert.equal(plan.release, true);
  assert.equal(plan.version, 'v0.9.0');
  assert.equal(plan.previous, 'v0.8.0');
  assert.deepEqual(plan.prs, [95, 94]);
  assert.equal(plan.ciSha, 'h2');
  assert.equal(plan.sha, 'h3');
});

test('只有发版记录这类文档 PR 时不发', () => {
  const plan = planRelease({
    ...base,
    changed: ['docs/PROGRESS.md', 'docs/DEPLOYMENT.md'],
    commits: [
      {
        sha: 'h3',
        subject: 'Merge pull request #93 from gchust/docs/release-v0.8.0',
        files: ['docs/PROGRESS.md'],
      },
    ],
  });
  assert.equal(plan.release, false);
  assert.match(plan.why, /文档/);
});

test('最新标签之后没有提交时不发', () => {
  const plan = planRelease({ ...base, changed: [], commits: [] });
  assert.equal(plan.release, false);
  assert.match(plan.why, /没有新的提交/);
});

test('有代码改动但没有合并的 PR（直接推送）时不发', () => {
  const plan = planRelease({
    ...base,
    changed: ['apps/mobile/a.ts'],
    commits: [{ sha: 'h3', subject: 'fix: hotfix', files: ['apps/mobile/a.ts'] }],
  });
  assert.equal(plan.release, false);
  assert.match(plan.why, /PR/);
});

test('一个标签都没有时不自动发第一版', () => {
  const plan = planRelease({ tags: [], head: 'h', changed: ['a.ts'], commits: [] });
  assert.equal(plan.release, false);
});

test('上一版：比这次小的最大版本号', () => {
  assert.equal(previousRelease('v0.9.0', ['v0.8.0', 'v0.3.3', 'v0.10.0-rc', 'v0.7.0']), 'v0.8.0');
  // 重跑同一个标签的发布时不和自己比。
  assert.equal(previousRelease('v0.9.0', ['v0.9.0', 'v0.8.0']), 'v0.8.0');
  assert.equal(previousRelease('v0.1.0', []), null);
});

test('已经有更高的版本时拒绝，versionCode 不能倒退', () => {
  assert.throws(() => previousRelease('v0.8.1', ['v0.9.0', 'v0.8.0']), /v0\.9\.0/);
  assert.throws(() => previousRelease('v0.9', ['v0.8.0']), /版本号/);
});

test('versionCode 是上一版加一，没有上一版时用运行编号', () => {
  assert.equal(nextVersionCode({ previousCode: 11, runNumber: 1 }), 12);
  assert.equal(nextVersionCode({ previousCode: 11, runNumber: 40 }), 12);
  assert.equal(nextVersionCode({ previousCode: null, runNumber: 3 }), 3);
});

test('versionCode 的输入不对时拒绝', () => {
  assert.throws(() => nextVersionCode({ previousCode: 0, runNumber: 1 }));
  assert.throws(() => nextVersionCode({ previousCode: 2_100_000_000, runNumber: 1 }), /上限/);
  assert.throws(() => nextVersionCode({ previousCode: null, runNumber: 0 }));
});
