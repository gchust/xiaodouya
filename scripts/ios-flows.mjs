#!/usr/bin/env node
// 用法：node scripts/ios-flows.mjs <e2e 目录> <输出目录>
// 把流程复制一份，改掉 iOS 上做不到的写法。流程文件只写一份，新加的流程也自动适用。
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEXT_MATCHER = /^(\s*(?:- )?(assertVisible|visible|text|tapOn|element): )(.+)$/;

function widen(key, value) {
  const inline = /^\{ text: (.+) \}$/.exec(value);
  if (inline) return `{ text: ${widen(key, inline[1])} }`;
  if (value.startsWith('{')) return null;
  const bare = value
    .replace(/^["']|["']$/g, '')
    .replace(/^\.\*/, '')
    .replace(/\.\*$/, '')
    // Maestro 先按原文比较，所以流程里可以直接写“尿尿 + 便便”。套上正则后加号要转义。
    .replace(/ \+ /g, ' \\+ ');
  // 点击要按开头匹配：“包含”会先点中别处提到同样文字的地方，比如喂奶卡片上的“12:00 喂奶 110ml”。
  // 用单引号：正则里的 \. 在 YAML 双引号里是非法转义。
  return key === 'tapOn' ? `'${bare}.*'` : `'.*${bare}.*'`;
}

/** 处理一个流程文件的文本。 */
export function adaptFlow(text) {
  return text
    .split('\n')
    .map((line) => {
      // Maestro 的 hideKeyboard 收不起 iOS 软键盘，换成点 E2E 构建里的按钮（见 overlays.tsx）。
      if (line === '- hideKeyboard') return '- tapOn: { id: e2e-hide-keyboard }';
      // macOS Runner 比 Android 的模拟器慢，图片处理也走软件渲染。
      const timeout = /^(\s*timeout: )(\d+)$/.exec(line);
      if (timeout) return `${timeout[1]}${Number(timeout[2]) * 2}`;
      // 图片旋转、裁剪在 Runner 上要十几秒，assertVisible 默认只等几秒。
      const idAssert = /^(\s*)- assertVisible: (\{ id: .+ \})$/.exec(line);
      if (idAssert) {
        const [, pad, selector] = idAssert;
        return `${pad}- extendedWaitUntil:\n${pad}    visible: ${selector}\n${pad}    timeout: 30000`;
      }
      // iOS 上按钮是一个无障碍元素，里面的字并进了它的标签，所以按“包含”匹配，
      // 比如“名字，Sprout2”里找 Sprout2。Android 上每段字是单独的元素，仍然按整段匹配。
      const matcher = TEXT_MATCHER.exec(line);
      if (matcher) {
        const widened = widen(matcher[2], matcher[3]);
        if (widened) return `${matcher[1]}${widened}`;
      }
      return line;
    })
    .join('\n');
}

function adaptDirectory(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) adaptDirectory(path);
    else if (name.endsWith('.yaml')) writeFileSync(path, adaptFlow(readFileSync(path, 'utf8')));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, target] = process.argv.slice(2);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  adaptDirectory(target);
}
