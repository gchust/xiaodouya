import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptFlow } from './ios-flows.mjs';

test('hideKeyboard 换成点 E2E 按钮', () => {
  assert.equal(adaptFlow('- hideKeyboard'), '- tapOn: { id: e2e-hide-keyboard }');
});

test('文字匹配改成包含', () => {
  assert.equal(adaptFlow('- assertVisible: Sprout2'), '- assertVisible: ".*Sprout2.*"');
  assert.equal(adaptFlow('- assertVisible: "70"'), '- assertVisible: ".*70.*"');
  assert.equal(adaptFlow('    visible: 喂奶 60ml'), '    visible: ".*喂奶 60ml.*"');
  assert.equal(adaptFlow('      text: 离线中.*'), '      text: ".*离线中.*"');
  assert.equal(adaptFlow('- tapOn: 喂奶 110ml'), '- tapOn: ".*喂奶 110ml.*"');
});

test('按 id 的匹配、输入和否定断言不动', () => {
  for (const line of [
    '- assertVisible: { id: feed-save }',
    '    visible: { id: today-screen }',
    '- tapOn: { id: action-feed }',
    '- inputText: First smile',
    '- assertNotVisible: E0000000X',
    '- extendedWaitUntil:',
    '    visible:',
  ]) {
    assert.equal(adaptFlow(line), line);
  }
});

test('等待时间放长一倍', () => {
  assert.equal(adaptFlow('    timeout: 15000'), '    timeout: 30000');
});
