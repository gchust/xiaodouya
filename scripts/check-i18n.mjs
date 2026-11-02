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
  // 迁移中，每迁完一个模块就删掉（F-91）。
  'apps/mobile/src/data/store.ts',
  'apps/mobile/src/data/uploadQueue.ts',
  'apps/mobile/src/lib/accountText.ts',
  'apps/mobile/src/lib/api.ts',
  'apps/mobile/src/lib/app.tsx',
  'apps/mobile/src/lib/avatar.ts',
  'apps/mobile/src/lib/bookHtml.ts',
  'apps/mobile/src/lib/book.ts',
  'apps/mobile/src/lib/dates.ts',
  'apps/mobile/src/lib/DownloadButton.tsx',
  'apps/mobile/src/lib/downloadCore.ts',
  'apps/mobile/src/lib/media.ts',
  'apps/mobile/src/lib/mediaUtils.ts',
  'apps/mobile/src/lib/mediaViews.tsx',
  'apps/mobile/src/lib/notifications.ts',
  'apps/mobile/src/lib/pendingPick.tsx',
  'apps/mobile/src/lib/remoteSummary.ts',
  'apps/mobile/src/lib/storagePage.ts',
  'apps/mobile/src/lib/UploadCard.tsx',
  'apps/mobile/src/lib/uploadStatus.ts',
  'apps/mobile/src/screens/AccountPanels.tsx',
  'apps/mobile/src/screens/AuthScreens.tsx',
  'apps/mobile/src/screens/DocumentScreen.tsx',
  'apps/mobile/src/screens/FamilyScreen.tsx',
  'apps/mobile/src/screens/InfoScreen.tsx',
  'apps/mobile/src/screens/NutritionScreen.tsx',
  'apps/mobile/src/screens/RecallScreen.tsx',
  'apps/mobile/src/screens/RecordsScreen.tsx',
  'apps/mobile/src/screens/StorageScreen.tsx',
  'apps/mobile/src/screens/StorageUsagePage.tsx',
  'apps/mobile/src/screens/TodayScreen.tsx',
  'apps/mobile/src/screens/ViewerScreen.tsx',
  'apps/mobile/src/sheets/formulaSheets.tsx',
  'apps/mobile/src/sheets/MomentSheet.tsx',
  'apps/mobile/src/sheets/recordSheets.tsx',
  'apps/mobile/app/(tabs)/_layout.tsx',
  'apps/mobile/src/sheets/vaccineSheets.tsx',
  'apps/mobile/src/ui/AvatarEditor.tsx',
  'apps/mobile/src/ui/BirthPicker.tsx',
  'apps/mobile/src/ui/NotificationPrompt.tsx',
  'apps/mobile/src/ui/overlays.tsx',
  'apps/mobile/src/ui/SyncingPlaceholder.tsx',
  'apps/mobile/src/ui/TimeField.tsx',
  'apps/mobile/src/widgets/controller.tsx',
  'apps/mobile/src/widgets/views.tsx',
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

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(
    `\n${problems.length} 处问题。用户可见文案放进 packages/shared/src/i18n 的中英文目录，见 AGENTS.md 第 5 节。`,
  );
  process.exitCode = 1;
}
if (problems.length === 0) console.log('check-i18n: ok');
