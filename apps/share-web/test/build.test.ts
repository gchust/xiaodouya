import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** 真的跑一次打包，查最后发布的文件。 */
const here = resolve(import.meta.dirname, '..');
const artifacts = resolve(here, '../../.artifacts');
const API = 'https://fictional-ref.supabase.co/functions/v1/api';

function runBuild(apiUrl: string, outdir: string) {
  return execFileSync('node', ['build.mjs', outdir], {
    cwd: here,
    env: { ...process.env, EXPO_PUBLIC_API_URL: apiUrl, EXPO_PUBLIC_API_REGION: 'ap-southeast-1' },
    stdio: 'pipe',
  });
}

describe('打包结果', () => {
  let out = '';
  let html = '';
  let headers = '';
  let script = '';

  beforeAll(() => {
    out = mkdtempSync(resolve(artifacts, 'share-web-build-'));
    runBuild(API, out);
    html = readFileSync(resolve(out, 'index.html'), 'utf8');
    headers = readFileSync(resolve(out, '_headers'), 'utf8');
    const file = readdirSync(resolve(out, 'assets')).find((f) => f.endsWith('.js'));
    script = readFileSync(resolve(out, 'assets', file ?? ''), 'utf8');
  }, 60_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('页面上有兜底的 meta，标题和预览没有宝宝信息', () => {
    expect(html).toContain('<meta name="robots" content="noindex,nofollow"');
    expect(html).toContain('<meta name="referrer" content="no-referrer"');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain('<title>小豆芽 · Xiaodouya</title>');
    expect(html).not.toMatch(/og:image/);
  });

  it('响应头：不进索引、不发 Referer、严格的 CSP', () => {
    expect(headers).toContain('X-Robots-Tag: noindex');
    expect(headers).toContain('Referrer-Policy: no-referrer');
    const csp = /Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('connect-src https://fictional-ref.supabase.co');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('http:');
    // Cloudflare 限制 _headers 每行 2000 字符。
    for (const line of headers.split('\n')) expect(line.length).toBeLessThan(2000);
  });

  it('没有内联脚本和样式，不加载任何第三方资源', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/style="/);
    const external = html.match(/(?:src|href)="https?:[^"]*"/g) ?? [];
    expect(external).toEqual([]);
    expect(script).not.toContain('fonts.googleapis');
    expect(script).not.toContain('googletagmanager');
  });

  it('线上构建不放行 http 的文件', () => {
    const csp =
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).not.toContain('localhost');
    expect(html).not.toContain('localhost');
  });

  it('API 地址和地区打进了页面', () => {
    expect(script).toContain('fictional-ref.supabase.co');
    expect(script).toContain('ap-southeast-1');
  });

  it('wrangler 配置只有静态文件：没有代码入口、账号和域名', () => {
    const toml = readFileSync(resolve(here, 'wrangler.toml'), 'utf8');
    expect(toml).toMatch(/\[assets\]\s+directory = "\.\/dist"/);
    expect(toml).not.toMatch(/^main\s*=/m);
    expect(toml).not.toMatch(/^account_id\s*=/m);
    expect(toml).not.toMatch(/^routes?\s*=/m);
    expect(toml).not.toMatch(/^\s*run_worker_first/m);
  });

  it('API 不是 https 时拒绝打包，令牌不能明文发送', () => {
    expect(() => runBuild('http://api.fictional.test', resolve(artifacts, 'never'))).toThrow();
  });
});
