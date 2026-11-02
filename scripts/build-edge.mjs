#!/usr/bin/env node
// 把服务端打成一个文件给 Edge Function 用，产物不提交。
//
// 为什么不用 deno.json 的 import map 直接引用源码：服务端和 packages/shared 的相对导入都没有扩展名，
// Deno 不解析，而 shared 还要给 Metro 用。打包后函数只依赖 node: 内置模块，部署时不用再解析 npm 包，
// 依赖版本也和测试跑过的锁文件一致。
import { readFileSync, statSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = resolve(root, 'apps/server');
const { build } = createRequire(resolve(serverDir, 'package.json'))('esbuild');

const builtins = new Set(builtinModules.filter((name) => !name.startsWith('_')));

/** postgres 写的是 import net from 'net'。不带 node: 前缀的内置模块在 Deno 里解析不了。 */
const nodePrefix = {
  name: 'node-prefix',
  setup(b) {
    b.onResolve({ filter: /^[a-z_/]+$/ }, (args) =>
      builtins.has(args.path) ? { path: `node:${args.path}`, external: true } : null,
    );
    b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }));
  },
};

/**
 * AWS SDK 的 browser 映射把 XML 解析换成 DOMParser，Deno 没有它。S3 的 PUT、HEAD 不解析响应体，
 * 所以一直没事；分片上传的开始、列分片、完成都要解析，一调用就抛错。node 版的解析器是纯 JS，直接用它。
 */
const xmlParser = {
  name: 'xml-parser',
  setup(b) {
    b.onResolve({ filter: /^\.\/xml-parser/ }, (args) =>
      args.importer.includes('@aws-sdk/xml-builder')
        ? { path: resolve(dirname(args.importer), 'xml-parser.js') }
        : null,
    );
  },
};

// 较早的 Deno 不给用户代码提供这些全局变量，只给 npm 包。打包之后依赖也算用户代码。
const banner = `import { Buffer as __Buffer } from 'node:buffer';
import __process from 'node:process';
import { setImmediate as __setImmediate, clearImmediate as __clearImmediate } from 'node:timers';
globalThis.Buffer ??= __Buffer;
globalThis.process ??= __process;
globalThis.global ??= globalThis;
globalThis.setImmediate ??= __setImmediate;
globalThis.clearImmediate ??= __clearImmediate;`;

const outfile = resolve(root, process.argv[2] ?? 'supabase/functions/api/_bundle/server.mjs');

await build({
  entryPoints: [resolve(serverDir, 'src/edge.ts')],
  outfile,
  absWorkingDir: serverDir,
  bundle: true,
  format: 'esm',
  // browser 目标让 AWS SDK 走 fetch 和 WebCrypto，不碰 node:http 和 ~/.aws/config。
  // Edge Function 里读不了家目录，而且这样打出来小得多。
  platform: 'browser',
  mainFields: ['browser', 'module', 'main'],
  conditions: ['browser', 'import', 'default'],
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  banner: { js: banner },
  plugins: [nodePrefix, xmlParser],
  logLevel: 'warning',
});

const bundle = readFileSync(outfile, 'utf8');

// 冷启动不能跑迁移。迁移的 SQL 只要被打进来，就说明有人从 edge.ts 引用了 migrate。
for (const forbidden of ['pg_advisory_xact_lock', 'CREATE TABLE users']) {
  if (bundle.includes(forbidden)) {
    console.error(`Edge 产物里不应该有“${forbidden}”：不要在 Edge Function 里执行迁移`);
    process.exit(1);
  }
}

if (bundle.includes('new DOMParser')) {
  console.error('Edge 产物里不应该有 DOMParser：Deno 没有它，解析 S3 的响应时会抛错');
  process.exit(1);
}

const { size } = statSync(outfile);
// 服务端打包的上限是 5 MB，本地打包是 20 MB。留出余量，超了就在这里发现，不要等部署。
const LIMIT = 5 * 1024 * 1024;
if (size > LIMIT) {
  console.error(`Edge 产物 ${size} 字节，超过 ${LIMIT} 字节的上限`);
  process.exit(1);
}

const imports = [...new Set(bundle.match(/from\s*"(node:[^"]+)"/g) ?? [])]
  .map((m) => m.replace(/from\s*"/, '').replace(/"$/, ''))
  .sort();
console.log(`Edge 产物：${outfile}（${(size / 1024 / 1024).toFixed(2)} MB）`);
console.log(`依赖的内置模块：${imports.join(' ')}`);
