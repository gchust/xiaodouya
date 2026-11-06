#!/usr/bin/env node
// 自动发版（.github/workflows/auto-release.yml）和 release.yml 用的版本规则。说明见 docs/DEPLOYMENT.md 的“自动发版”。
//
//   node scripts/release-plan.mjs plan                  看最新标签到 HEAD 之间要不要发，打印 JSON
//   node scripts/release-plan.mjs previous <标签>        标准输入是已发布的标签，打印上一版（没有时为空）
//   node scripts/release-plan.mjs version-code <上一版的 versionCode 或空> <运行编号>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DOCS } from './ci-changes.mjs';

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
// Android 的 versionCode 上限是 2100000000。
const MAX_VERSION_CODE = 2_100_000_000;

function parse(tag) {
  const match = TAG.exec(tag);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** 按版本号取最大的 vX.Y.Z，别的标签（rc、手误）不算。 */
export function latestTag(tags) {
  let best = null;
  for (const tag of tags) {
    const version = parse(tag);
    if (version && (!best || compare(version, best.version) > 0)) best = { tag, version };
  }
  return best ? best.tag : null;
}

/** 和以往手动发版一致：次版本号加一，修订号归零。 */
export function nextVersion(tags) {
  const latest = latestTag(tags);
  if (!latest) return 'v0.1.0';
  const [major, minor] = parse(latest);
  return `v${major}.${minor + 1}.0`;
}

/** GitHub 的合并提交和 squash 提交（标题末尾的 (#N)）。 */
export function prsFrom(subjects) {
  const numbers = [];
  for (const subject of subjects) {
    const match = /^Merge pull request #(\d+) /.exec(subject) ?? /\(#(\d+)\)$/.exec(subject);
    const number = match ? Number(match[1]) : null;
    if (number && !numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

/** 空列表不算纯文档：多半是取差异出错了。 */
export function docsOnly(files) {
  return files.length > 0 && files.every((file) => DOCS.some((pattern) => pattern.test(file)));
}

/**
 * main 上纯文档的推送不触发 CI（ci.yml 的 paths-ignore），所以 HEAD 上可能没有 CI。
 * 从新到旧找第一个不全是文档的提交，它就是 CI 测过、和 HEAD 代码一样的那个。
 */
export function ciCommit(commits) {
  const tested = commits.find((commit) => !docsOnly(commit.files));
  return tested ? tested.sha : null;
}

/**
 * @param {{ tags: string[], head: string, changed: string[], commits: { sha: string, subject: string, files: string[] }[] }} input
 *   commits 是最新标签到 HEAD 的 first-parent 提交，从新到旧；changed 是这段的全部改动。
 */
export function planRelease({ tags, head, changed, commits }) {
  const previous = latestTag(tags);
  const base = { release: false, previous, version: null, sha: head, ciSha: null, prs: [] };
  if (!previous) return { ...base, why: '还没有 vX.Y.Z 标签，第一版要手动发布' };
  if (commits.length === 0) return { ...base, why: `${previous} 之后没有新的提交` };
  const prs = prsFrom(commits.map((commit) => commit.subject));
  if (prs.length === 0) return { ...base, why: `${previous} 之后没有合并的 PR` };
  if (docsOnly(changed))
    return {
      ...base,
      prs,
      why: `${previous} 之后只改了文档（${prs.map((n) => `#${n}`).join(' ')}）`,
    };
  return {
    ...base,
    release: true,
    version: nextVersion(tags),
    prs,
    ciSha: ciCommit(commits),
    why: `${previous} 之后合并了 ${prs.length} 个 PR，有代码改动`,
  };
}

/** 比 current 小的最大版本。已经有更大的版本时抛错：versionCode 会倒退，Android 不允许降级安装。 */
export function previousRelease(current, tags) {
  const version = parse(current);
  if (!version) throw new Error(`版本号必须是 vX.Y.Z：${current}`);
  let best = null;
  for (const tag of tags) {
    const other = parse(tag);
    if (!other || tag === current) continue;
    if (compare(other, version) > 0)
      throw new Error(`已经发布过更高的 ${tag}，不能再发 ${current}`);
    if (!best || compare(other, best.version) > 0) best = { tag, version: other };
  }
  return best ? best.tag : null;
}

/**
 * 上一版 APK 里的 versionCode 加一。以前用 release.yml 的运行编号，但被 auto-release.yml 调用时
 * 运行编号是调用方的，会从 1 开始。只有第一次发布（没有上一版）才用运行编号。
 */
export function nextVersionCode({ previousCode, runNumber }) {
  if (previousCode === null) {
    if (!Number.isInteger(runNumber) || runNumber < 1)
      throw new Error(`运行编号不对：${runNumber}`);
    return runNumber;
  }
  if (!Number.isInteger(previousCode) || previousCode < 1)
    throw new Error(`上一版的 versionCode 不对：${previousCode}`);
  if (previousCode >= MAX_VERSION_CODE)
    throw new Error(`versionCode 到了 Android 的上限 ${MAX_VERSION_CODE}`);
  return previousCode + 1;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function lines(text) {
  return text.split('\n').filter(Boolean);
}

function gather() {
  const tags = lines(git('tag', '--list', 'v*'));
  const head = git('rev-parse', 'HEAD').trim();
  const latest = latestTag(tags);
  if (!latest) return { tags, head, changed: [], commits: [] };
  try {
    git('merge-base', '--is-ancestor', latest, head);
  } catch {
    throw new Error(`${latest} 不在 HEAD 的历史里，先人工核对标签`);
  }
  const commits = git('log', '--first-parent', '--format=%H%x1f%s%x1f%b%x1e', `${latest}..${head}`)
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, body = ''] = entry.split('\x1f');
      const files = lines(git('diff', '--name-only', `${sha}^1`, sha));
      // 合并提交的正文第一行是 PR 标题。
      const title = /^Merge pull request #/.test(subject) ? (lines(body)[0] ?? subject) : subject;
      return { sha, subject, title, files };
    });
  const changed = lines(git('diff', '--name-only', latest, head));
  return { tags, head, changed, commits };
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'plan') {
    const input = gather();
    const plan = planRelease(input);
    // 发版说明：PR 编号和标题，GitHub 自动生成的说明会接在后面。
    const pulls = input.commits.flatMap((commit) => {
      const [number] = prsFrom([commit.subject]);
      return number ? [{ number, title: commit.title }] : [];
    });
    console.log(JSON.stringify({ ...plan, pulls }));
    return;
  }
  if (command === 'previous') {
    const tags = lines(readFileSync(0, 'utf8')).map((tag) => tag.trim());
    console.log(previousRelease(args[0], tags) ?? '');
    return;
  }
  if (command === 'version-code') {
    const previousCode = args[0] ? Number(args[0]) : null;
    console.log(nextVersionCode({ previousCode, runNumber: Number(args[1]) }));
    return;
  }
  throw new Error(
    '用法：release-plan.mjs plan | previous <标签> | version-code <上一版> <运行编号>',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
