import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptFlow } from './ios-flows.mjs';

test('hideKeyboard 换成点 E2E 按钮', () => {
  assert.equal(adaptFlow('- hideKeyboard'), '- tapOn: { id: e2e-hide-keyboard }');
});

test('文字匹配改成包含', () => {
  assert.equal(adaptFlow('- assertVisible: Sprout2'), "- assertVisible: '.*Sprout2.*'");
  assert.equal(adaptFlow('- assertVisible: "70"'), "- assertVisible: '.*70.*'");
  assert.equal(adaptFlow('    visible: 喂奶 60ml'), "    visible: '.*喂奶 60ml.*'");
  assert.equal(adaptFlow('      text: 离线中.*'), "      text: '.*离线中.*'");
});

test('正则里的反斜杠要能通过 YAML，滚动的目标也按包含匹配', () => {
  assert.equal(adaptFlow('    text: .*(100\\.4°F|发烧).*'), "    text: '.*(100\\.4°F|发烧).*'");
  assert.equal(adaptFlow('    element: Rabies'), "    element: '.*Rabies.*'");
  assert.equal(adaptFlow('    element: { id: sign-out }'), '    element: { id: sign-out }');
});

test('写在花括号里的文字、加号和按 id 的断言', () => {
  assert.equal(
    adaptFlow('    element: { text: 还没有数据 }'),
    "    element: { text: '.*还没有数据.*' }",
  );
  assert.equal(adaptFlow('- assertVisible: 尿尿 + 便便'), "- assertVisible: '.*尿尿 \\+ 便便.*'");
  assert.equal(
    adaptFlow('- assertVisible: { id: avatar-save }'),
    '- extendedWaitUntil:\n    visible: { id: avatar-save }\n    timeout: 30000',
  );
});

test('点击按开头匹配，不会点中别处提到同样文字的地方', () => {
  assert.equal(adaptFlow('- tapOn: 喂奶 110ml'), "- tapOn: '喂奶 110ml.*'");
});

test('按 id 的匹配、输入和否定断言不动', () => {
  for (const line of [
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
