#!/usr/bin/env node
// 打包分享页，产物在 dist/，由 Cloudflare Worker 的静态资源发布（wrangler.toml）。
//
//   EXPO_PUBLIC_API_URL=https://... [EXPO_PUBLIC_API_REGION=...] node build.mjs [输出目录]
//
// API 地址写死在页面里：页面是公开的，这个地址本来就在 APK 里。
// 本地的 http 地址只用来走查：这时也放行本机的 http 文件，线上构建没有这条路。
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, process.argv[2] ?? 'dist');
const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? '').trim().replace(/\/+$/, '');
const apiRegion = (process.env.EXPO_PUBLIC_API_REGION ?? '').trim();

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2']);
let api;
try {
  api = new URL(apiUrl);
} catch {
  console.error('要设置 EXPO_PUBLIC_API_URL，比如 https://<项目>.supabase.co/functions/v1/api');
  process.exit(1);
}
const isLocal = api.protocol === 'http:' && LOCAL_HOSTS.has(api.hostname);
if (api.protocol !== 'https:' && !isLocal) {
  console.error('EXPO_PUBLIC_API_URL 必须是 https：令牌要经过这个地址发送');
  process.exit(1);
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(resolve(outdir, 'assets'), { recursive: true });

/** zod 把几十种语言的报错文字都导出了，占 300 多 KB。这里用不上：校验失败只会显示“暂时打不开”。 */
const dropZodLocales = {
  name: 'drop-zod-locales',
  setup(b) {
    b.onResolve({ filter: /\/locales\/index\.js$/ }, () => ({
      path: 'zod-locales',
      namespace: 'empty',
    }));
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export {};' }));
  },
};

const result = await build({
  absWorkingDir: here,
  entryPoints: { app: resolve(here, 'src/main.ts'), styles: resolve(here, 'src/styles.css') },
  outdir: resolve(outdir, 'assets'),
  entryNames: '[name]-[hash]',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  metafile: true,
  plugins: [dropZodLocales],
  define: {
    __API_URL__: JSON.stringify(apiUrl),
    __API_REGION__: JSON.stringify(apiRegion),
    __ALLOW_LOCAL_HTTP__: JSON.stringify(isLocal),
  },
  logLevel: 'warning',
});

const outputs = Object.keys(result.metafile.outputs).map((file) => resolve(here, file));
const named = (suffix) => {
  const file = outputs.find((path) => path.endsWith(suffix));
  if (!file) throw new Error(`没有打出 ${suffix}`);
  return file.slice(outdir.length + 1);
};

// 文件存在哪家的存储由家庭决定（R2、S3、自建），所以图片和视频只能限制到 https。
const localMedia = isLocal ? ' http://localhost:* http://127.0.0.1:*' : '';
const directives = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  `img-src 'self' https:${localMedia}`,
  `media-src https:${localMedia}`,
  `connect-src ${api.origin}`,
  "base-uri 'none'",
  "form-action 'none'",
  // 就算哪里漏了 textContent，Chromium 也不让把字符串当 HTML 写进页面。
  "require-trusted-types-for 'script'",
];
const metaCsp = directives.join('; ');
// frame-ancestors 只在响应头里生效，meta 里写了浏览器会报错。
const headerCsp = [...directives, "frame-ancestors 'none'"].join('; ');

const html = readFileSync(resolve(here, 'public/index.html'), 'utf8')
  .replaceAll('__CSP__', metaCsp)
  .replaceAll('__SCRIPT__', named('.js'))
  .replaceAll('__STYLES__', named('.css'));
writeFileSync(resolve(outdir, 'index.html'), html);
cpSync(resolve(here, 'public/favicon.svg'), resolve(outdir, 'favicon.svg'));
cpSync(resolve(here, 'public/robots.txt'), resolve(outdir, 'robots.txt'));

// Cloudflare 读这个文件，不会把它当静态资源发出去。见 docs/DEPLOYMENT.md。
writeFileSync(
  resolve(outdir, '_headers'),
  `/*
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: ${headerCsp}

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`,
);

// esbuild 的 hash 只随内容变，名字里带它，换版本时不用担心旧缓存。
const size = (file) => (readFileSync(resolve(outdir, file)).length / 1024).toFixed(0);
console.log(
  `分享页：${outdir}（脚本 ${size(named('.js'))} KB，样式 ${size(named('.css'))} KB，API ${api.origin}）`,
);
