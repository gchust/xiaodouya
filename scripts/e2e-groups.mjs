#!/usr/bin/env node
// 分组是 CI 跑哪些流程的唯一依据：流程不在分组里，CI 就悄悄不跑它，所以这里要拦住。
// 用法：
//   node scripts/e2e-groups.mjs check         检查 e2e/groups.json，pnpm check 会跑
//   node scripts/e2e-groups.mjs names         一行一个分组名
//   node scripts/e2e-groups.mjs matrix        分组名的 JSON 数组，给 CI 的 matrix
//   node scripts/e2e-groups.mjs plan <分组>   一行一个文件：前置 + 流程，按执行顺序
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const flowNames = (dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length));

/** 返回所有问题；空数组表示通过。参数都显式传入，测试才能喂坏数据。 */
export function findProblems(manifest, flows, setups) {
  const problems = [];
  const onDisk = new Set(flows);
  const setupOnDisk = new Set(setups);
  const owners = new Map();

  for (const [group, { flows: list, setup }] of Object.entries(manifest.groups)) {
    for (const name of list) owners.set(name, [...(owners.get(name) ?? []), group]);
    for (const name of setup) {
      if (!setupOnDisk.has(name)) problems.push(`分组 ${group} 的前置 ${name} 不在 e2e/setup 里`);
    }
    // 串行时验证过的就是文件名顺序，“要在谁之前”的约束都靠它成立。
    const sorted = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (list.join() !== sorted.join()) {
      problems.push(`分组 ${group} 没有按文件名排序，应该是：${sorted.join(' ')}`);
    }
    if (!setup.includes('onboard') && list[0] !== '01_onboarding') {
      problems.push(`分组 ${group} 没有账号：前置要有 onboard，或者第一条是 01_onboarding`);
    }

    list.forEach((name, index) => {
      const before = new Set([...setup, ...list.slice(0, index)]);
      for (const need of manifest.requires[name] ?? []) {
        if (!need.split('|').some((option) => before.has(option))) {
          problems.push(`流程 ${name} 依赖 ${need}，在分组 ${group} 里没有排在它前面`);
        }
      }
      // 这些流程跑完 App 不再是管理员，后面接别的流程会登录错账号。
      if (manifest.endOfGroup.includes(name)) {
        for (const later of list.slice(index + 1)) {
          if (!manifest.endOfGroup.includes(later)) {
            problems.push(`流程 ${later} 排在 ${name} 后面，跑到它时 App 已经不是管理员`);
          }
        }
      }
    });
  }

  for (const name of flows) {
    const groups = owners.get(name) ?? [];
    if (groups.length === 0) problems.push(`流程 ${name} 没有分配分组，CI 不会跑它`);
    if (groups.length > 1) problems.push(`流程 ${name} 同时在 ${groups.join('、')} 里`);
  }
  for (const name of owners.keys()) {
    if (!onDisk.has(name)) problems.push(`分组里的 ${name} 不在 e2e/flows 里`);
  }

  // 文件校验按“这组跑没跑对应的流程”决定查不查，流程改了名这条校验就悄悄没了。
  for (const [check, names] of Object.entries(manifest.uploadChecks)) {
    for (const name of names) {
      if (!owners.has(name)) problems.push(`文件校验 ${check} 依赖的 ${name} 不在任何分组里`);
    }
  }
  for (const name of [...Object.keys(manifest.requires), ...manifest.endOfGroup]) {
    if (!onDisk.has(name)) problems.push(`依赖表里的 ${name} 不在 e2e/flows 里`);
  }
  return problems;
}

function main([command, group]) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'e2e/groups.json'), 'utf8'));
  const names = Object.keys(manifest.groups);
  if (command === 'check') {
    const problems = findProblems(manifest, flowNames('e2e/flows'), flowNames('e2e/setup'));
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) {
      console.error('分组写在 e2e/groups.json，规则见 e2e/README.md。');
      process.exitCode = 1;
    }
  } else if (command === 'names') {
    console.log(names.join('\n'));
  } else if (command === 'matrix') {
    console.log(JSON.stringify(names));
  } else if (command === 'plan' && names.includes(group)) {
    const { setup, flows } = manifest.groups[group];
    const files = [
      ...setup.map((name) => `e2e/setup/${name}.yaml`),
      ...flows.map((name) => `e2e/flows/${name}.yaml`),
    ];
    console.log(files.join('\n'));
  } else {
    console.error(`用法：e2e-groups.mjs check | names | matrix | plan <${names.join('|')}>`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
