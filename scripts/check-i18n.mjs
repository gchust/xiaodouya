#!/usr/bin/env node
// 防回退：apps/mobile 的代码里不能再出现中文字符串字面量（注释不算），用户可见文案走
// packages/shared/src/i18n 的目录。也不能在模块顶层调用 t()：那时语言还没定，之后也不会变。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(root, 'package.json'))('typescript');

const ROOTS = ['apps/mobile/src', 'apps/mobile/app'];

/** 明确豁免。每个文件写清楚为什么，不要因为迁移麻烦就加进来。 */
const EXEMPT = new Set([
  // E2E 专用的假数据，不进正式界面。
  'apps/mobile/src/lib/e2eFixtures.ts',
]);

// 汉字、CJK 标点、全角字符。
const CJK = /[㐀-鿿　-〿＀-￯]/;

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

function isTextNode(node) {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    node.kind === ts.SyntaxKind.JsxText
  );
}

function check(file) {
  const source = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const problems = [];
  const report = (node, message) => {
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart());
    problems.push(`${path.relative(root, file)}:${line + 1}  ${message}`);
  };
  const visit = (node, insideFunction) => {
    if (isTextNode(node) && CJK.test(node.getText())) {
      report(node, `中文字面量 ${node.getText().trim().slice(0, 60)}`);
    }
    if (
      !insideFunction &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 't'
    ) {
      report(node, '模块顶层调用 t()，语言切换后不会更新');
    }
    const inside = insideFunction || ts.isFunctionLike(node) || ts.isClassLike(node); // 类的字段初始化在 new 时才运行。
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(tree, false);
  return problems;
}

const problems = ROOTS.flatMap((dir) => sourceFiles(path.join(root, dir)))
  .filter((file) => !EXEMPT.has(path.relative(root, file).split(path.sep).join('/')))
  .flatMap(check);

// 服务端用到的错误码，英文表里都要有，否则英文界面只能显示中文的 message。
const serverCode = /fail\(\s*\d+,\s*'([a-z_]+)'/g;
const appSource = fs.readFileSync(path.join(root, 'apps/server/src/app.ts'), 'utf8');
const apiErrors = fs.readFileSync(path.join(root, 'packages/shared/src/i18n/apiErrors.ts'), 'utf8');
for (const [, code] of appSource.matchAll(serverCode)) {
  if (!new RegExp(`^\\s*${code}:`, 'm').test(apiErrors)) {
    problems.push(`apps/server/src/app.ts  错误码 ${code} 在 i18n/apiErrors.ts 里没有英文`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(
    `\n${problems.length} 处问题。用户可见文案放进 packages/shared/src/i18n 的中英文目录，见 AGENTS.md 第 5 节。`,
  );
  process.exitCode = 1;
}
if (problems.length === 0) console.log('check-i18n: ok');
