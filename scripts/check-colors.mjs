#!/usr/bin/env node
// 防回退（F-142，主题配色）：App 的颜色只能来自 apps/mobile/src/themes/palettes.ts 的调色板。
//
// 1. 代码里不能写颜色字面量（#rgb、rgba()、'white' 这类名字）：写死的颜色换主题和深色模式时不会变。
// 2. 模块顶层不能读 colors.xxx：模块只加载一次，读到的是启动时的主题，换主题后不会更新。
//    样式表用 themedStyles(() => ({...}))，见 apps/mobile/src/themes/runtime.ts。
// 3. Reanimated 的 worklet 里不能直接读 colors：worklet 会把捕获的对象冻结，之后换主题改不了它。
//    先在组件里读成局部变量再在 worklet 里用。
// 4. RefreshControl 要写 progressBackgroundColor：Android 下拉刷新的圆盘默认是白的，深色模式下是一块亮斑（issue #105）。
// 5. 黑底的全屏查看器只能用不随主题和深浅变的颜色（white、black、media*，SPEC“主题配色”）：
//    主题的 paper、accentLight 在深色下是深色，黑底上看不见（issue #105 走查时的视频加载转圈）。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(root, 'package.json'))('typescript');

const ROOTS = ['apps/mobile/src', 'apps/mobile/app'];

/** 明确豁免。每个文件写清楚为什么。 */
const EXEMPT = new Set([
  // 调色板本身。
  'apps/mobile/src/themes/palettes.ts',
  // 桌面小工具在后台任务里画，有自己的浅色和深色两套（SPEC“桌面小工具”），不跟随 App 的主题。
  'apps/mobile/src/widgets/palette.ts',
  // 导出的成长册是要打印的 PDF，永远是白纸黑字，不跟主题和深色模式。
  'apps/mobile/src/lib/bookHtml.ts',
]);

/** 整页是黑底查看器的文件。 */
const BLACK_VIEWERS = new Set(['apps/mobile/src/screens/ViewerScreen.tsx']);
const FIXED_TOKEN = /^(?:white|black|media[A-Z]\w*)$/;

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^\s*(?:rgba?|hsla?)\(/i;
const NAMED = new Set([
  'white',
  'black',
  'red',
  'green',
  'blue',
  'gray',
  'grey',
  'yellow',
  'orange',
  'purple',
  'pink',
  'brown',
]);
const WORKLET_HOOKS = new Set([
  'useAnimatedStyle',
  'useAnimatedProps',
  'useDerivedValue',
  'useAnimatedReaction',
  'runOnUI',
]);

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** 字面量所在的属性名（style 的键或 JSX 属性），用来判断 'white' 这种词是不是颜色。 */
function ownerName(node) {
  const parent = node.parent;
  if (parent && ts.isPropertyAssignment(parent) && parent.initializer === node) {
    return parent.name.getText();
  }
  if (parent && ts.isJsxAttribute(parent)) return parent.name.getText();
  if (parent && ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) {
    return parent.parent.name.getText();
  }
  return '';
}

function check(file) {
  const blackViewer = BLACK_VIEWERS.has(path.relative(root, file).split(path.sep).join('/'));
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
  const visit = (node, insideFunction, insideWorklet) => {
    if (ts.isStringLiteralLike(node)) {
      const text = node.text.trim();
      if (HEX.test(text) || FUNC.test(text)) {
        report(node, `颜色字面量 ${text}，用 colors 里的令牌`);
      } else if (NAMED.has(text.toLowerCase()) && /colou?r$/i.test(ownerName(node))) {
        report(node, `颜色名字 '${text}'，用 colors 里的令牌`);
      }
    }
    const readsColors =
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'colors';
    if (readsColors && !insideFunction) {
      report(node, `模块顶层读 ${node.getText()}，换主题后不会更新`);
    }
    if (readsColors && insideWorklet) {
      report(node, `worklet 里读 ${node.getText()}，先在组件里读成局部变量`);
    }
    if (readsColors && blackViewer && !FIXED_TOKEN.test(node.name.text)) {
      report(
        node,
        `黑底查看器里读 ${node.getText()}，用 white、black 或 media*（不随主题和深浅变）`,
      );
    }
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === 'RefreshControl' &&
      !node.attributes.properties.some(
        (attr) => ts.isJsxAttribute(attr) && attr.name.getText() === 'progressBackgroundColor',
      )
    ) {
      report(node, 'RefreshControl 没写 progressBackgroundColor，Android 上是白色的圆盘');
    }
    const worklet =
      insideWorklet ||
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        WORKLET_HOOKS.has(node.expression.text));
    const inside = insideFunction || ts.isFunctionLike(node) || ts.isClassLike(node);
    ts.forEachChild(node, (child) => visit(child, inside, worklet));
  };
  visit(tree, false, false);
  return problems;
}

const problems = ROOTS.flatMap((dir) => sourceFiles(path.join(root, dir)))
  .filter((file) => !EXEMPT.has(path.relative(root, file).split(path.sep).join('/')))
  .flatMap(check);

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(
    `\n${problems.length} 处问题。颜色放进 apps/mobile/src/themes/palettes.ts，见 docs/design/SPEC.md“主题配色”。`,
  );
  process.exitCode = 1;
} else {
  console.log('check-colors: ok');
}
