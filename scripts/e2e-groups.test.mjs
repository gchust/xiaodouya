import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findProblems } from './e2e-groups.mjs';

const manifest = () => ({
  groups: {
    a: { setup: ['onboard', 'record-bcg'], flows: ['03_moment', '14_viewer', '20_viewer_role'] },
    b: { setup: [], flows: ['01_onboarding', '02_records'] },
  },
  requires: { '14_viewer': ['03_moment'], '02_records': ['01_onboarding|record-bcg'] },
  endOfGroup: ['20_viewer_role'],
  uploadChecks: { memory: ['03_moment'] },
});
const flows = ['01_onboarding', '02_records', '03_moment', '14_viewer', '20_viewer_role'];
const setups = ['onboard', 'record-bcg'];

test('全部分配好时没有问题', () => {
  assert.deepEqual(findProblems(manifest(), flows, setups), []);
});

test('新流程没有分组时失败', () => {
  const problems = findProblems(manifest(), [...flows, '23_new'], setups);
  assert.match(problems.join(), /23_new 没有分配分组/);
});

test('同一条流程在两组时失败', () => {
  const m = manifest();
  m.groups.b.flows.push('14_viewer');
  assert.match(findProblems(m, flows, setups).join(), /14_viewer 同时在 a、b 里/);
});

test('分组写了不存在的流程时失败（流程改名后常见）', () => {
  const problems = findProblems(
    manifest(),
    flows.filter((f) => f !== '14_viewer'),
    setups,
  );
  assert.match(problems.join(), /分组里的 14_viewer 不在 e2e\/flows 里/);
});

test('前置不在组内时失败', () => {
  const m = manifest();
  m.groups.a.flows = ['14_viewer', '20_viewer_role'];
  m.groups.b.flows = ['01_onboarding', '02_records', '03_moment'];
  assert.match(findProblems(m, flows, setups).join(), /14_viewer 依赖 03_moment/);
});

test('前置排在后面时失败', () => {
  const m = manifest();
  m.requires['03_moment'] = ['14_viewer'];
  assert.match(findProblems(m, flows, setups).join(), /03_moment 依赖 14_viewer/);
});

test('可选前置满足其一就够', () => {
  const m = manifest();
  m.groups.a.flows = ['03_moment', '14_viewer', '20_viewer_role'];
  m.requires['14_viewer'] = ['missing|record-bcg'];
  assert.deepEqual(findProblems(m, flows, setups), []);
});

test('没按文件名排序时失败', () => {
  const m = manifest();
  m.groups.a.flows = ['14_viewer', '03_moment', '20_viewer_role'];
  assert.match(findProblems(m, flows, setups).join(), /没有按文件名排序/);
});

test('管理员退出后不能再接别的流程', () => {
  const m = manifest();
  m.groups.a.flows.push('23_new');
  assert.match(findProblems(m, [...flows, '23_new'], setups).join(), /23_new 排在 20_viewer_role/);
});

test('文件校验依赖的流程改名后失败，否则这条校验会悄悄消失', () => {
  const m = manifest();
  m.uploadChecks.memory = ['03_old_name'];
  assert.match(findProblems(m, flows, setups).join(), /memory 依赖的 03_old_name/);
});

test('没有账号的分组失败', () => {
  const m = manifest();
  m.groups.a.setup = [];
  assert.match(findProblems(m, flows, setups).join(), /分组 a 没有账号/);
});

test('前置文件不存在时失败', () => {
  assert.match(findProblems(manifest(), flows, ['onboard']).join(), /前置 record-bcg/);
});
