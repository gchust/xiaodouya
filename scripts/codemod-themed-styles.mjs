#!/usr/bin/env node
// 一次性的机械替换（F-142），并行分支 rebase 后可以再跑一次：
// 模块顶层读了 colors 的 `const s = StyleSheet.create({...})` 改成
// `const s = themedStyles(() => ({...}))`，并补上 themedStyles 的导入。写成箭头函数直接返回对象，
// 格式化后对象的缩进不变，差异只有首尾两行，和并行分支的冲突最少。
// 已经包过的不会再包。用法：node scripts/codemod-themed-styles.mjs，然后 pnpm format。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(root, 'package.json'))('typescript');

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

const isStyleSheetCreate = (node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.getText() === 'StyleSheet.create';

let changed = 0;
for (const file of ['apps/mobile/src', 'apps/mobile/app'].flatMap((d) =>
  sourceFiles(path.join(root, d)),
)) {
  const source = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [];
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      const init = decl.initializer;
      if (!init) continue;
      // 早先包成了 themedStyles(() => StyleSheet.create({...}))，拆掉里面那层。
      if (
        ts.isCallExpression(init) &&
        init.expression.getText() === 'themedStyles' &&
        init.arguments[0] &&
        ts.isArrowFunction(init.arguments[0]) &&
        isStyleSheetCreate(init.arguments[0].body)
      ) {
        const inner = init.arguments[0].body;
        edits.push({
          start: init.getStart(),
          end: init.getEnd(),
          text: `themedStyles(() => (${inner.arguments[0].getText()}))`,
        });
        continue;
      }
      if (!isStyleSheetCreate(init) || !/\bcolors\./.test(init.getText())) continue;
      edits.push({
        start: init.getStart(),
        end: init.getEnd(),
        text: `themedStyles(() => (${init.arguments[0].getText()}))`,
      });
    }
  }
  if (edits.length === 0) continue;
  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  if (
    !/\bthemedStyles\b[^(]/.test(
      out
        .split('\n')
        .filter((l) => l.startsWith('import'))
        .join('\n'),
    )
  ) {
    const themeImport = /import \{([^}]*)\} from '((?:\.\.?\/)+(?:src\/)?theme)';/;
    const match = themeImport.exec(out);
    if (!match) throw new Error(`${file}: no import from theme`);
    const names = match[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    names.push('themedStyles');
    out = out.replace(themeImport, `import { ${names.sort().join(', ')} } from '${match[2]}';`);
  }
  fs.writeFileSync(file, out);
  changed += 1;
  console.log(`${path.relative(root, file)}: ${edits.length}`);
}
console.log(`${changed} files`);
