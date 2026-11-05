/**
 * 在真实的 Deno 里跑 Edge Function 的入口，连开发用的 Postgres 和 S3，走一遍主要流程。
 * 需要先 pnpm dev:infra 和 pnpm build:edge。
 *
 *   pnpm --filter @xiaodouya/server test:edge                     普通 Deno
 *   EDGE_SMOKE_RUNTIME=edge-runtime pnpm ... test:edge            Supabase 开源的 edge-runtime 镜像
 *   EDGE_SMOKE_DATABASE_URL=... pnpm ... test:edge                让函数连别的地址（比如本地连接池）
 *   EDGE_SMOKE_DB_SSL=require EDGE_SMOKE_CA_FILE=...              函数用 TLS 连接，信任这个 CA
 *
 * 这里证明的是代码能在这些运行环境里工作，不等于在 Supabase 线上验证过。
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config';
import { hashPassword, verifyPassword } from '../src/crypto';
import { connect, migrate } from '../src/db';
import { ensureBucket } from '../src/dev-bucket';
import { type FakeGithub, startFakeGithub } from './fake-github';

const repo = resolve(import.meta.dirname, '../../..');
const mode = process.env.EDGE_SMOKE_RUNTIME ?? 'deno';
const EDGE_RUNTIME_IMAGE = 'supabase/edge-runtime:v1.77.9';
/** Deno 的 TLS 即使在 ssl: require 下也校验证书链，连自签名的本地连接池要把 CA 交给它。 */
const caFile = process.env.EDGE_SMOKE_CA_FILE;

function exampleEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(resolve(repo, 'apps/server/.env.example'), 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1]) env[match[1]] = match[2] ?? '';
  }
  return env;
}

function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`失败：${what}`);
  console.log(`  ok  ${what}`);
}

interface Runtime {
  base: string;
  output: () => string;
  stop: () => Promise<void>;
}

function startProcess(command: string, args: string[], env: Record<string, string>) {
  const child: ChildProcess = spawn(command, args, {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  let output = '';
  child.stdout?.on('data', (d) => {
    output += String(d);
  });
  child.stderr?.on('data', (d) => {
    output += String(d);
  });
  return { child, output: () => output };
}

async function startRuntime(env: Record<string, string>, port: number): Promise<Runtime> {
  let stop: () => Promise<void>;
  let output: () => string;
  if (mode === 'edge-runtime') {
    const name = `xiaodouya-edge-smoke-${process.pid}-${port}`;
    const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    if (caFile) {
      flags.push('-v', `${caFile}:/smoke-ca.crt:ro`, '-e', 'SSL_CERT_FILE=/smoke-ca.crt');
      flags.push('-e', 'DENO_TLS_CA_STORE=mozilla,system');
    }
    const started = startProcess(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        name,
        '--network',
        'host',
        '-v',
        `${repo}/supabase/functions/api:/functions/api:ro`,
        '-v',
        `${repo}/apps/server/test/edge/main-service:/main:ro`,
        ...flags,
        EDGE_RUNTIME_IMAGE,
        'start',
        '--main-service',
        '/main',
        '-p',
        String(port),
      ],
      {},
    );
    output = started.output;
    stop = async () => {
      await new Promise((done) => spawn('docker', ['rm', '-f', name]).on('close', done));
    };
  } else {
    const started = startProcess(
      'deno',
      [
        'run',
        '--allow-all',
        '--no-lock',
        '--preload',
        'apps/server/test/edge/preload.mjs',
        'supabase/functions/api/index.ts',
      ],
      {
        ...env,
        DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}`,
        ...(caFile ? { SSL_CERT_FILE: caFile, DENO_TLS_CA_STORE: 'mozilla,system' } : {}),
      },
    );
    output = started.output;
    stop = async () => {
      started.child.kill();
      await new Promise((done) => started.child.on('close', done));
    };
  }

  const base = `http://127.0.0.1:${port}/api`;
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) break;
    } catch {}
    if (Date.now() - started > 120_000) {
      await stop();
      throw new Error(`函数没有启动：\n${output()}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`  --  第一次 healthz 成功用了 ${Date.now() - started} ms（${mode}）`);
  return { base, output, stop };
}

const example = exampleEnv();
const config = loadConfig({ ...example, S3_PUBLIC_ENDPOINT: 'http://localhost:59000' });
const admin = connect(process.env.DATABASE_URL ?? config.databaseUrl);
const database = `xiaodouya_edge_${process.pid}_${Date.now()}`;
await admin.unsafe(`CREATE DATABASE ${database}`);

function databaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

const directUrl = databaseUrl(process.env.DATABASE_URL ?? config.databaseUrl);
const functionUrl = databaseUrl(process.env.EDGE_SMOKE_DATABASE_URL ?? directUrl);
const sql = connect(directUrl);

const functionEnv: Record<string, string> = {
  DATABASE_URL: functionUrl,
  // 本地 Postgres 没有 TLS。线上默认是 require，TLS 单独用开了 SSL 的容器验证。
  DB_SSL: process.env.EDGE_SMOKE_DB_SSL ?? '',
  APP_SECRET: example.APP_SECRET ?? '',
  S3_ENDPOINT: 'http://localhost:59000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:59000',
  S3_REGION: example.S3_REGION ?? '',
  S3_BUCKET: example.S3_BUCKET ?? '',
  S3_ACCESS_KEY_ID: example.S3_ACCESS_KEY_ID ?? '',
  S3_SECRET_ACCESS_KEY: example.S3_SECRET_ACCESS_KEY ?? '',
  S3_FORCE_PATH_STYLE: 'true',
  // 配了 S3 默认就是托管模式。这里要测存储测试接口和 SSRF 拒绝，所以显式打开。
  ALLOW_CUSTOM_STORAGE: 'true',
  // 每次用自己的前缀，不碰开发时手动发布的版本。
  APP_RELEASE_PREFIX: `releases-edge-${process.pid}-${Date.now()}/android/`,
};

async function request<T>(
  base: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<{ status: number; json: T; ms: number; headers: Headers }> {
  const started = Date.now();
  const response = await fetch(`${base}${path}`, {
    method,
    signal: options.signal,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    json: (await response.json()) as T,
    ms: Date.now() - started,
    headers: response.headers,
  };
}

const feed = () => ({
  id: randomUUID(),
  collection: 'event',
  data: { type: 'feed', at: Date.now(), ml: 90, byName: '爸爸' },
  deleted: false,
  updatedAt: Date.now(),
});

async function mainFlow(runtime: Runtime) {
  const { base } = runtime;
  type Auth = { token: string };

  console.log('账号：scrypt 在 Node 和函数之间互通');
  const email = `edge-${randomUUID().slice(0, 8)}@example.test`;
  const registered = await request<Auth>(base, 'POST', '/v1/auth/register', {
    body: { email, password: 'correct horse', displayName: '虚构用户' },
  });
  check(registered.status === 201, `注册（${registered.ms} ms）`);
  check(registered.headers.get('cache-control') === 'no-store', '带令牌的响应禁止缓存');
  const [row] = await sql<{ password_hash: string }[]>`
    SELECT password_hash FROM users WHERE email = ${email}`;
  check(
    await verifyPassword('correct horse', row?.password_hash ?? ''),
    '函数算的哈希在 Node 上能验证',
  );

  const oldEmail = `edge-old-${randomUUID().slice(0, 8)}@example.test`;
  await sql`INSERT INTO users (id, email, password_hash, display_name)
    VALUES (${randomUUID()}, ${oldEmail}, ${await hashPassword('old password')}, '虚构用户')`;
  const oldLogin = await request<Auth>(base, 'POST', '/v1/auth/login', {
    body: { email: oldEmail, password: 'old password' },
  });
  check(oldLogin.status === 200, `Node 算的哈希在函数里能登录（${oldLogin.ms} ms）`);
  const wrong = await request(base, 'POST', '/v1/auth/login', {
    body: { email: oldEmail, password: 'wrong password' },
  });
  check(wrong.status === 401, '错误密码被拒绝');

  const owner = registered.json.token;
  console.log('事务：建家庭、邀请');
  const family = await request(base, 'POST', '/v1/families', {
    token: owner,
    body: { name: '虚构一家', label: '爸爸' },
  });
  check(family.status === 201, '建家庭（sql.begin）');
  const invite = await request<{ code: string }>(base, 'POST', '/v1/invites', {
    token: owner,
    body: { role: 'caregiver', label: '妈妈' },
  });
  const member = oldLogin.json.token;
  const accepted = await request(base, 'POST', '/v1/invites/accept', {
    token: member,
    body: { code: invite.json.code },
  });
  check(accepted.status === 200, '接受邀请（条件更新加事务）');

  console.log('同步：FOR UPDATE、sql.json、长轮询');
  const write = await request<{ records: { id: string }[]; cursor: number }>(
    base,
    'POST',
    '/v1/sync',
    { token: owner, body: { cursor: 0, changes: [feed()] } },
  );
  check(write.status === 200 && write.json.records.length === 1, '写入并读回一条记录');
  const pull = await request<{ records: unknown[]; cursor: number }>(base, 'POST', '/v1/sync', {
    token: member,
    body: { cursor: 0, changes: [] },
  });
  check(pull.json.records.length === 1, '家人能拉到');

  const started = Date.now();
  const waiting = request<{ changed: boolean }>(
    base,
    'GET',
    `/v1/sync/wait?cursor=${pull.json.cursor}`,
    { token: member },
  );
  await new Promise((r) => setTimeout(r, 300));
  await request(base, 'POST', '/v1/sync', { token: owner, body: { cursor: 0, changes: [feed()] } });
  const woken = await waiting;
  check(
    woken.json.changed === true && Date.now() - started < 5000,
    `写入后长轮询被唤醒（${Date.now() - started} ms）`,
  );
  check(woken.headers.get('cache-control') === 'no-store', '长轮询的响应禁止缓存');

  const controller = new AbortController();
  const abandoned = request(base, 'GET', '/v1/sync/wait?cursor=99999', {
    token: member,
    signal: controller.signal,
  }).catch(() => 'aborted');
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  check((await abandoned) === 'aborted', '客户端可以断开等待');
  const after = await request(base, 'GET', '/healthz');
  check(after.status === 200, '断开后函数继续正常工作');

  if (mode === 'deno') {
    await new Promise((r) => setTimeout(r, 300));
    check(runtime.output().includes('[smoke] waitUntil'), '后台任务交给了 EdgeRuntime.waitUntil');
    check(runtime.output().includes('[smoke] background done'), '后台任务正常结束');
  }

  console.log('文件：预签名、HEAD、下载（SDK 走 fetch）');
  const bytes = Buffer.from('fake image content'.repeat(50));
  const mediaId = randomUUID();
  const upload = await request<{ url: string; headers: Record<string, string> }>(
    base,
    'POST',
    '/v1/media/upload-url',
    {
      token: owner,
      body: {
        id: mediaId,
        scope: 'memory',
        variant: 'original',
        mime: 'image/jpeg',
        size: bytes.length,
      },
    },
  );
  check(upload.status === 200, '生成上传链接');
  const put = await fetch(upload.json.url, {
    method: 'PUT',
    headers: upload.json.headers,
    body: bytes,
  });
  check(put.status === 200, '预签名链接能上传');
  const done = await request(base, 'POST', `/v1/media/${mediaId}/complete`, {
    token: owner,
    body: { variant: 'original' },
  });
  check(done.status === 200, '完成校验（HEAD）');
  const urls = await request<{ urls: { url: string }[] }>(base, 'POST', '/v1/media/urls', {
    token: owner,
    body: { items: [{ id: mediaId, variant: 'original' }] },
  });
  const downloaded = await fetch(urls.json.urls[0]?.url ?? '');
  check(
    Buffer.from(await downloaded.arrayBuffer()).equals(bytes),
    '下载内容和上传一致（预签名下载）',
  );

  // 证件照的缩略图（F-131）：资料页的卡片要用，链接和证件原件一样不超过 10 分钟。
  const docThumbBytes = Buffer.from('xiaodouya-fictional-document-thumb');
  const docThumbId = randomUUID();
  const docThumbUpload = await request<{ url: string; headers: Record<string, string> }>(
    base,
    'POST',
    '/v1/media/upload-url',
    {
      token: owner,
      body: {
        id: docThumbId,
        scope: 'document',
        variant: 'thumb',
        mime: 'image/jpeg',
        size: docThumbBytes.length,
      },
    },
  );
  check(docThumbUpload.status === 200, '证件缩略图能申请上传链接');
  await fetch(docThumbUpload.json.url, {
    method: 'PUT',
    headers: docThumbUpload.json.headers,
    body: docThumbBytes,
  });
  const docThumbDone = await request(base, 'POST', `/v1/media/${docThumbId}/complete`, {
    token: owner,
    body: { variant: 'thumb' },
  });
  check(docThumbDone.status === 200, '证件缩略图能完成');
  const docThumbUrls = await request<{ urls: { url: string | null; expiresIn: number }[] }>(
    base,
    'POST',
    '/v1/media/urls',
    { token: owner, body: { items: [{ id: docThumbId, variant: 'thumb' }] } },
  );
  const docThumb = docThumbUrls.json.urls[0];
  check(
    Boolean(docThumb?.url) &&
      docThumb!.expiresIn <= 600 &&
      Number(new URL(docThumb!.url!).searchParams.get('X-Amz-Expires')) <= 600,
    '证件缩略图的签名链接不超过 10 分钟',
  );
  const docThumbDownload = await fetch(docThumb?.url ?? '');
  check(
    Buffer.from(await docThumbDownload.arrayBuffer()).equals(docThumbBytes),
    '证件缩略图下载内容和上传一致',
  );

  // 开始、列分片、完成都要解析存储返回的 XML，单个 PUT 用不到这条路径，所以要单独跑一遍。
  console.log('分片上传：开始、断点查询、完成、取消（SDK 解析 XML）');
  const partFile = Buffer.alloc(8 * 1024 * 1024 + 321, 9);
  const multipartId = randomUUID();
  const multipart = await request<{ uploadId: string; partSize: number }>(
    base,
    'POST',
    '/v1/media/multipart',
    {
      token: owner,
      body: {
        id: multipartId,
        scope: 'memory',
        variant: 'original',
        mime: 'video/mp4',
        size: partFile.length,
      },
    },
  );
  check(multipart.status === 200 && Boolean(multipart.json.uploadId), '开始分片上传');
  const { uploadId, partSize } = multipart.json;
  const ref = { variant: 'original', uploadId };
  const partUrls = await request<{ urls: { partNumber: number; url: string }[] }>(
    base,
    'POST',
    `/v1/media/${multipartId}/multipart/part-urls`,
    { token: owner, body: { ...ref, partNumbers: [1, 2] } },
  );
  check(partUrls.status === 200 && partUrls.json.urls.length === 2, '取分片链接');
  const putPart = async (index: number) => {
    const entry = partUrls.json.urls[index];
    const start = index * partSize;
    const response = await fetch(entry?.url ?? '', {
      method: 'PUT',
      body: partFile.subarray(start, start + partSize),
    });
    return response.status;
  };
  check((await putPart(0)) === 200, '预签名链接能传第一片');
  const halfway = await request<{ parts: { partNumber: number; size: number }[] }>(
    base,
    'POST',
    `/v1/media/${multipartId}/multipart/parts`,
    { token: owner, body: ref },
  );
  check(
    halfway.status === 200 && halfway.json.parts.map((p) => p.partNumber).join() === '1',
    '断点查询只看到已传的片（ListParts）',
  );
  check((await putPart(1)) === 200, '补传第二片');
  const merged = await request(base, 'POST', `/v1/media/${multipartId}/multipart/complete`, {
    token: owner,
    body: ref,
  });
  check(merged.status === 200, '完成分片上传（ListParts + CompleteMultipartUpload + HEAD）');
  const mergedUrls = await request<{ urls: { url: string }[] }>(base, 'POST', '/v1/media/urls', {
    token: owner,
    body: { items: [{ id: multipartId, variant: 'original' }] },
  });
  const mergedFile = await fetch(mergedUrls.json.urls[0]?.url ?? '');
  check(Buffer.from(await mergedFile.arrayBuffer()).equals(partFile), '合并后的内容和上传一致');

  const cancelledId = randomUUID();
  const toCancel = await request<{ uploadId: string }>(base, 'POST', '/v1/media/multipart', {
    token: owner,
    body: {
      id: cancelledId,
      scope: 'memory',
      variant: 'original',
      mime: 'video/mp4',
      size: partFile.length,
    },
  });
  check(toCancel.status === 200, '再开始一个分片上传');
  const cancelled = await request(base, 'POST', `/v1/media/${cancelledId}/cancel`, {
    token: owner,
  });
  check(cancelled.status === 200, '取消上传');
  const afterCancel = await request(base, 'POST', `/v1/media/${cancelledId}/multipart/parts`, {
    token: owner,
    body: { variant: 'original', uploadId: toCancel.json.uploadId },
  });
  check(afterCancel.status === 404, '取消后查询返回 upload_gone');

  return owner;
}

/** 分享页的公开接口：不登录、跨域、令牌在请求体里；再看一天有很多文件时要签多久。 */
/** 应用内更新：发布脚本写清单，函数读清单（SDK 的 GetObject）并签下载链接。 */
async function appUpdate(base: string, token: string) {
  console.log('应用内更新：读清单、签下载链接');
  const none = await request<{ update: unknown }>(
    base,
    'GET',
    '/v1/app/update?platform=android&versionCode=1',
    { token },
  );
  check(none.status === 200 && none.json.update === null, '还没发布时没有更新');
  const dir = mkdtempSync(join(tmpdir(), 'xiaodouya-edge-release-'));
  try {
    const apk = randomBytes(50_000);
    writeFileSync(join(dir, 'fake.apk'), apk);
    await promisify(execFile)(
      'bash',
      [resolve(repo, 'scripts/publish-apk.sh'), join(dir, 'fake.apk'), '0.9.0', '90'],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          S3_ENDPOINT: functionEnv.S3_ENDPOINT,
          S3_REGION: functionEnv.S3_REGION,
          S3_BUCKET: functionEnv.S3_BUCKET,
          S3_ACCESS_KEY_ID: functionEnv.S3_ACCESS_KEY_ID,
          S3_SECRET_ACCESS_KEY: functionEnv.S3_SECRET_ACCESS_KEY,
          APP_RELEASE_PREFIX: functionEnv.APP_RELEASE_PREFIX,
          RELEASE_APK_CHECK: '0',
        },
      },
    );
    const found = await request<{ update: { versionCode: number; sha256: string; url: string } }>(
      base,
      'GET',
      '/v1/app/update?platform=android&versionCode=89',
      { token },
    );
    check(found.status === 200 && found.json.update.versionCode === 90, '发布后查到新版本');
    const downloaded = Buffer.from(await (await fetch(found.json.update.url)).arrayBuffer());
    check(
      createHash('sha256').update(downloaded).digest('hex') === found.json.update.sha256 &&
        downloaded.equals(apk),
      '签名链接下载回来的和发布的一致',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function publicShare(base: string) {
  console.log('分享一天：公开接口');
  type Auth = { token: string };
  const registered = await request<Auth>(base, 'POST', '/v1/auth/register', {
    body: {
      email: `edge-share-${randomUUID().slice(0, 8)}@example.test`,
      password: 'correct horse',
      displayName: '虚构用户',
    },
  });
  const owner = registered.json.token;
  const created = await request<{ family: { id: string } }>(base, 'POST', '/v1/families', {
    token: owner,
    body: { name: '虚构一家', label: '爸爸' },
  });
  const familyId = created.json.family.id;
  const at = Date.UTC(2026, 5, 15, 2);
  const bytes = Buffer.from('xiaodouya-fictional-share');
  const mediaId = randomUUID();
  const upload = await request<{ url: string; headers: Record<string, string> }>(
    base,
    'POST',
    '/v1/media/upload-url',
    {
      token: owner,
      body: {
        id: mediaId,
        scope: 'memory',
        variant: 'original',
        mime: 'image/jpeg',
        size: bytes.length,
      },
    },
  );
  await fetch(upload.json.url, { method: 'PUT', headers: upload.json.headers, body: bytes });
  await request(base, 'POST', `/v1/media/${mediaId}/complete`, {
    token: owner,
    body: { variant: 'original' },
  });
  // 照片的预览：分享页要发它，不发原图。内容不一样才分得清。
  const previewBytes = Buffer.from('xiaodouya-fictional-preview');
  const previewUpload = await request<{ url: string; headers: Record<string, string> }>(
    base,
    'POST',
    '/v1/media/upload-url',
    {
      token: owner,
      body: {
        id: mediaId,
        scope: 'memory',
        variant: 'preview',
        mime: 'image/jpeg',
        size: previewBytes.length,
      },
    },
  );
  check(previewUpload.status === 200, '预览能申请上传链接');
  await fetch(previewUpload.json.url, {
    method: 'PUT',
    headers: previewUpload.json.headers,
    body: previewBytes,
  });
  const previewDone = await request(base, 'POST', `/v1/media/${mediaId}/complete`, {
    token: owner,
    body: { variant: 'preview' },
  });
  check(previewDone.status === 200, '预览能完成');
  await request(base, 'POST', '/v1/sync', {
    token: owner,
    body: {
      cursor: 0,
      changes: [
        {
          id: familyId,
          collection: 'baby',
          data: { name: '测试豆', birthAt: at - 30 * 86_400_000 },
          deleted: false,
          updatedAt: Date.now(),
        },
        {
          id: randomUUID(),
          collection: 'event',
          data: { type: 'feed', at, ml: 90, byName: '爸爸', extra: '不该出现' },
          deleted: false,
          updatedAt: Date.now(),
        },
        {
          id: randomUUID(),
          collection: 'moment',
          data: {
            title: '虚构回忆',
            text: '',
            at,
            milestone: false,
            media: [{ id: mediaId, kind: 'image', mime: 'image/jpeg', size: bytes.length }],
          },
          deleted: false,
          updatedAt: Date.now(),
        },
      ],
    },
  });
  const share = await request<{ id: string; token: string }>(base, 'POST', '/v1/shares', {
    token: owner,
    body: {
      fromAt: Date.UTC(2026, 5, 14, 16),
      toAt: Date.UTC(2026, 5, 15, 16),
      timezone: 'Asia/Singapore',
      units: { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' },
    },
  });
  check(share.status === 201, '创建链接');

  const preflight = await fetch(`${base}/v1/public/share`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://share.fictional.test',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-region',
    },
  });
  check(
    preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*',
    '预检不用登录',
  );

  const open = async (token: string) => {
    const response = await fetch(`${base}/v1/public/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://share.fictional.test' },
      body: JSON.stringify({ token }),
    });
    return { response, text: await response.text() };
  };
  const page = await open(share.json.token);
  check(page.response.status === 200, '不登录能打开');
  check(page.response.headers.get('access-control-allow-origin') === '*', '响应带 CORS 头');
  check(page.response.headers.get('cache-control') === 'no-store', '响应禁止缓存');
  check(!page.text.includes('不该出现'), '多余字段发不出去');
  const parsed = JSON.parse(page.text) as {
    baby: { dayNumber: number };
    events: unknown[];
    moments: { media: { url: string }[] }[];
  };
  check(parsed.events.length === 1 && parsed.baby.dayNumber === 31, '内容和第几天');
  const download = await fetch(parsed.moments[0]?.media[0]?.url ?? '');
  check(
    Buffer.from(await download.arrayBuffer()).equals(previewBytes),
    '签名链接能下载，照片给的是预览',
  );
  check(!page.text.includes(`${mediaId}/original`), '有预览时响应里没有原图');

  const miss = await open('A'.repeat(43));
  check(
    miss.response.status === 404 &&
      miss.response.headers.get('access-control-allow-origin') === '*',
    '不存在的令牌 404，也带 CORS 头',
  );
  const notFromOutside = await fetch(`${base}/v1/config`, {
    headers: { origin: 'https://share.fictional.test' },
  });
  await notFromOutside.text();
  check(notFromOutside.headers.get('access-control-allow-origin') === null, '其他接口没有 CORS');

  // 200 个文件各有原图和缩略图，是这个接口最贵的情况。Edge Function 的 CPU 时间有限，要知道它离上限多远。
  const manyIds = Array.from({ length: 200 }, () => randomUUID());
  for (const id of manyIds) {
    for (const variant of ['original', 'thumb']) {
      await sql`INSERT INTO media (id, variant, family_id, scope, mime, size, object_key, status)
        VALUES (${id}, ${variant}, ${familyId}, 'memory', 'image/jpeg', 1, ${`families/${familyId}/memory/${id}/${variant}`}, 'ready')`;
    }
  }
  const chunks = [manyIds.slice(0, 100), manyIds.slice(100)];
  await request(base, 'POST', '/v1/sync', {
    token: owner,
    body: {
      cursor: 0,
      changes: chunks.map((ids) => ({
        id: randomUUID(),
        collection: 'moment',
        data: {
          title: '很多照片',
          text: '',
          at,
          milestone: false,
          media: ids.map((id) => ({ id, kind: 'image', mime: 'image/jpeg', size: 1 })),
        },
        deleted: false,
        updatedAt: Date.now(),
      })),
    },
  });
  const started = Date.now();
  const heavy = await open(share.json.token);
  const signatures = heavy.text.match(/X-Amz-Signature/g)?.length ?? 0;
  check(
    heavy.response.status === 200,
    `200 个文件也能打开（${Date.now() - started} ms，${signatures} 个签名）`,
  );
  check(
    (JSON.parse(heavy.text) as { omittedMedia: number }).omittedMedia === 1,
    '超出上限的文件如实告诉页面',
  );

  const revoked = await request(base, 'DELETE', `/v1/shares/${share.json.id}`, { token: owner });
  check(revoked.status === 200, '撤销');
  check((await open(share.json.token)).response.status === 404, '撤销后打不开');

  // 同一个家庭的回忆再分享成时间线：一个有预览的、两个各 100 张的。
  console.log('分享时间线（F-133）：公开接口');
  const timeline = await request<{ id: string; token: string }>(
    base,
    'POST',
    '/v1/shares/timeline',
    {
      token: owner,
      body: {
        fromAt: Date.UTC(2026, 5, 14, 16),
        toAt: Date.UTC(2026, 5, 15, 16),
        timezone: 'Asia/Singapore',
      },
    },
  );
  check(timeline.status === 201, '创建时间线链接');
  for (const path of ['/v1/public/share/timeline', '/v1/public/share/timeline/moment']) {
    const preflight = await fetch(`${base}${path}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://share.fictional.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-region',
      },
    });
    check(
      preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*',
      `${path} 预检不用登录`,
    );
  }
  const post = async (path: string, body: Record<string, string>) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://share.fictional.test' },
      body: JSON.stringify(body),
    });
    return { response, text: await response.text() };
  };
  const tlStarted = Date.now();
  const firstPage = await post('/v1/public/share/timeline', { token: timeline.json.token });
  const tlMs = Date.now() - tlStarted;
  check(
    firstPage.response.status === 200 &&
      firstPage.response.headers.get('access-control-allow-origin') === '*' &&
      firstPage.response.headers.get('cache-control') === 'no-store',
    `时间线不登录能打开（${tlMs} ms，${firstPage.text.match(/X-Amz-Signature/g)?.length ?? 0} 个签名）`,
  );
  const entries = (
    JSON.parse(firstPage.text) as {
      entries: { id: string; title: string; cover: { url: string } | null; visualCount: number }[];
      nextCursor: string | null;
    }
  ).entries;
  check(
    entries.length === 3 &&
      !firstPage.text.includes('"events"') &&
      !firstPage.text.includes('不该出现'),
    '时间线只有回忆，没有喂奶记录',
  );
  check(
    (firstPage.text.match(/X-Amz-Signature/g)?.length ?? 0) <= entries.length * 2,
    '一页只签封面',
  );
  const withPreview = entries.find((entry) => entry.title === '虚构回忆');
  const coverDownload = await fetch(withPreview?.cover?.url ?? '');
  check(
    Buffer.from(await coverDownload.arrayBuffer()).equals(previewBytes),
    '封面的签名链接能下载，照片给的是预览',
  );
  const many = entries.find((entry) => entry.title === '很多照片');
  const momentStarted = Date.now();
  const opened = await post('/v1/public/share/timeline/moment', {
    token: timeline.json.token,
    momentId: many?.id ?? '',
  });
  const openedMedia = opened.response.ok
    ? (JSON.parse(opened.text) as { media: unknown[] }).media
    : [];
  check(
    opened.response.status === 200 && openedMedia.length === 100,
    `点开一条 100 张的回忆（${Date.now() - momentStarted} ms，${opened.text.match(/X-Amz-Signature/g)?.length ?? 0} 个签名）`,
  );
  const dayTokenOnTimeline = await post('/v1/public/share/timeline', { token: share.json.token });
  check(dayTokenOnTimeline.response.status === 404, '撤销了的一天的令牌打不开时间线');
  const tlRevoked = await request(base, 'DELETE', `/v1/shares/${timeline.json.id}`, {
    token: owner,
  });
  check(tlRevoked.status === 200, '撤销时间线');
  check(
    (await post('/v1/public/share/timeline', { token: timeline.json.token })).response.status ===
      404,
    '撤销后时间线打不开',
  );

  // 同样的回忆选两段分享（F-136）：走时间线的两个公开接口，只按选中的 id 查。
  console.log('分享回忆（F-136）：公开接口');
  const notChosen = entries.find((entry) => entry !== many && entry !== withPreview);
  const chosen = await request<{ id: string; token: string }>(base, 'POST', '/v1/shares/moments', {
    token: owner,
    body: {
      momentIds: [many?.id ?? '', withPreview?.id ?? ''],
      fromAt: Date.UTC(2026, 5, 14, 16),
      toAt: Date.UTC(2026, 5, 15, 16),
      timezone: 'Asia/Singapore',
    },
  });
  check(chosen.status === 201, '创建选中回忆的链接');
  const chosenPage = await post('/v1/public/share/timeline', { token: chosen.json.token });
  const chosenBody = chosenPage.response.ok
    ? (JSON.parse(chosenPage.text) as { kind: string; entries: { id: string }[] })
    : { kind: '', entries: [] };
  check(
    chosenPage.response.status === 200 &&
      chosenPage.response.headers.get('access-control-allow-origin') === '*' &&
      chosenBody.kind === 'moments' &&
      chosenBody.entries.length === 2 &&
      !chosenPage.text.includes(notChosen?.id ?? 'none'),
    '只有选中的两段，kind 是 moments',
  );
  const chosenOpened = await post('/v1/public/share/timeline/moment', {
    token: chosen.json.token,
    momentId: many?.id ?? '',
  });
  check(chosenOpened.response.status === 200, '点开选中的一段');
  const notChosenOpened = await post('/v1/public/share/timeline/moment', {
    token: chosen.json.token,
    momentId: notChosen?.id ?? '',
  });
  check(notChosenOpened.response.status === 404, '没选的那段打不开');
  const chosenAsDay = await post('/v1/public/share', { token: chosen.json.token });
  check(chosenAsDay.response.status === 404, '选中回忆的令牌打不开一天');
  const chosenRevoked = await request(base, 'DELETE', `/v1/shares/${chosen.json.id}`, {
    token: owner,
  });
  check(chosenRevoked.status === 200, '撤销选中回忆的链接');
  check(
    (await post('/v1/public/share/timeline', { token: chosen.json.token })).response.status === 404,
    '撤销后打不开',
  );
}

async function customStorage(base: string, token: string) {
  console.log('存储设置：写入、读回、删除（SDK 走 fetch）');
  const tested = await request<{ ok: boolean; message: string }>(base, 'POST', '/v1/storage/test', {
    token,
    body: {
      provider: 'other',
      endpoint: 'http://localhost:59000',
      bucket: example.S3_BUCKET,
      accessKeyId: example.S3_ACCESS_KEY_ID,
      secretAccessKey: example.S3_SECRET_ACCESS_KEY,
    },
  });
  check(tested.json.ok === true, `连接测试通过：${tested.json.message}`);
}

/** 线上没有设置邮件 Secret 时的行为，和响应之后在后台删文件。 */
async function accountLifecycle(base: string) {
  console.log('账号：没有邮件时跳过验证、导出、删除后存储里的文件也没了');
  const config = await request<{ passwordReset: boolean }>(base, 'GET', '/v1/config');
  check(config.status === 200 && config.json.passwordReset === false, '/v1/config 说没开邮件');
  const email = `edge-del-${randomUUID().slice(0, 8)}@example.test`;
  const forgot = await request(base, 'POST', '/v1/auth/password/forgot', { body: { email } });
  check(forgot.status === 503, '没有邮件时不能申请验证码');
  const { json: auth } = await request<{ token: string }>(base, 'POST', '/v1/auth/register', {
    body: { email, password: 'correct horse', displayName: '虚构用户' },
  });
  const token = auth.token;
  const me = await request<{ emailVerified: boolean }>(base, 'GET', '/v1/me', { token });
  check(me.json.emailVerified === true, '没有邮件时算作已验证，App 跳过这一步');
  // F-135：不禁止的话 Android 的 OkHttp 会把 /v1/me 写进 cache/http-cache。
  check(me.headers.get('cache-control') === 'no-store', '/v1/me 禁止缓存');
  await request(base, 'POST', '/v1/families', {
    token,
    body: { name: '虚构一家', label: '爸爸' },
  });
  const bytes = Buffer.from('fictional object');
  const id = randomUUID();
  const upload = await request<{ url: string; headers: Record<string, string> }>(
    base,
    'POST',
    '/v1/media/upload-url',
    {
      token,
      body: {
        id,
        scope: 'memory',
        variant: 'original',
        mime: 'image/jpeg',
        size: bytes.length,
      },
    },
  );
  await fetch(upload.json.url, { method: 'PUT', headers: upload.json.headers, body: bytes });
  await request(base, 'POST', `/v1/media/${id}/complete`, {
    token,
    body: { variant: 'original' },
  });
  const urls = await request<{ urls: { url: string }[] }>(base, 'POST', '/v1/media/urls', {
    token,
    body: { items: [{ id, variant: 'original' }] },
  });
  const download = urls.json.urls[0]?.url ?? '';
  check((await fetch(download)).status === 200, '文件存在');
  const exported = await request<{ media: unknown[] }>(base, 'GET', '/v1/family/export', { token });
  check(exported.status === 200 && exported.json.media.length === 1, '导出家庭数据');
  const wrong = await request(base, 'POST', '/v1/me/delete', {
    token,
    body: { password: 'wrong password' },
  });
  check(wrong.status === 403, '密码错误不删除');
  const deleted = await request(base, 'POST', '/v1/me/delete', {
    token,
    body: { password: 'correct horse' },
  });
  check(deleted.status === 200, `删除账号（${deleted.ms} ms）`);
  let status = 0;
  for (let i = 0; i < 50 && status !== 404; i++) {
    await new Promise((r) => setTimeout(r, 100));
    status = (await fetch(download)).status;
  }
  check(status === 404, '响应之后文件从存储里删掉了');
}

const FAKE_GITHUB_TOKEN = 'github_pat_FICTIONAL_edge_smoke';
/** 能在 App 里看反馈的维护者。名单在函数启动前就要定，每次跑换一个，开发数据库是共用的。 */
const FEEDBACK_VIEWER = `edge-maintainer-${randomUUID().slice(0, 8)}@example.test`;

/** 反馈：附件签名直传，函数里用 fetch 连（假的）GitHub，失败时留在队列里，日志里没有令牌。 */
async function feedback(runtime: Runtime, github: FakeGithub) {
  const { base } = runtime;
  console.log('反馈：附件直传、建 issue、GitHub 失败时留在队列');
  const config = await request<{ feedback: { enabled: boolean; attachments: boolean } }>(
    base,
    'GET',
    '/v1/config',
  );
  check(config.json.feedback.enabled && config.json.feedback.attachments, '/v1/config 说开了反馈');
  const email = `edge-fb-${randomUUID().slice(0, 8)}@example.test`;
  const { json: auth } = await request<{ token: string }>(base, 'POST', '/v1/auth/register', {
    body: { email, password: 'correct horse', displayName: '虚构用户' },
  });
  const diagnostics = { appVersion: '0.3.3', os: 'android', osVersion: '15', locale: 'zh' };
  const bytes = Buffer.from('xiaodouya-fictional-feedback');
  const id = randomUUID();
  const attachment = randomUUID();
  const created = await request<{ uploads: { url: string; headers: Record<string, string> }[] }>(
    base,
    'POST',
    '/v1/feedback',
    {
      token: auth.token,
      body: {
        id,
        text: '@octocat 闪退了 #1',
        diagnostics,
        attachments: [{ id: attachment, mime: 'image/jpeg', size: bytes.length }],
      },
    },
  );
  check(created.status === 201 && created.json.uploads.length === 1, '建草稿，拿到附件的上传链接');
  const put = await fetch(created.json.uploads[0]?.url ?? '', {
    method: 'PUT',
    headers: created.json.uploads[0]?.headers,
    body: bytes,
  });
  check(put.status === 200, '附件直传到存储');
  const submitted = await request<{ status: string }>(base, 'POST', `/v1/feedback/${id}/submit`, {
    token: auth.token,
  });
  check(submitted.json.status === 'sent', `提交并建 issue（${submitted.ms} ms）`);
  const issue = github.issues.at(-1);
  check(issue?.authorization === `Bearer ${FAKE_GITHUB_TOKEN}`, 'GitHub 收到带令牌的请求');
  check(
    Boolean(issue && !issue.body.includes(email) && !issue.body.includes(attachment)),
    'issue 里没有邮箱和附件',
  );
  check(
    Boolean(issue?.body.includes('````text') || issue?.body.includes('```text')),
    '文字在代码块里',
  );

  github.failNext(1, 502);
  const second = randomUUID();
  await request(base, 'POST', '/v1/feedback', {
    token: auth.token,
    body: { id: second, text: 'GitHub 挂了', diagnostics, attachments: [] },
  });
  const queued = await request<{ status: string }>(base, 'POST', `/v1/feedback/${second}/submit`, {
    token: auth.token,
  });
  check(queued.json.status === 'queued', 'GitHub 失败时留在队列里，请求本身成功');
  check(!runtime.output().includes(FAKE_GITHUB_TOKEN), '函数的日志里没有令牌');

  console.log('反馈附件的公开链接：同意公开的新反馈嵌进 issue，打开后跳到签名链接');
  const publicConfig = await request<{ feedback: { publicAttachments?: boolean } }>(
    base,
    'GET',
    '/v1/config',
  );
  check(publicConfig.json.feedback.publicAttachments === true, '/v1/config 说附件会公开');
  const shown = randomUUID();
  const shownFile = randomUUID();
  const shownCreated = await request<{
    uploads: { url: string; headers: Record<string, string> }[];
  }>(base, 'POST', '/v1/feedback', {
    token: auth.token,
    body: {
      id: shown,
      text: '公开附件的反馈',
      diagnostics,
      attachments: [{ id: shownFile, mime: 'image/jpeg', size: bytes.length }],
      publicAttachments: true,
    },
  });
  await fetch(shownCreated.json.uploads[0]?.url ?? '', {
    method: 'PUT',
    headers: shownCreated.json.uploads[0]?.headers,
    body: bytes,
  });
  const shownSent = await request<{ status: string }>(
    base,
    'POST',
    `/v1/feedback/${shown}/submit`,
    {
      token: auth.token,
    },
  );
  check(shownSent.json.status === 'sent', '同意公开的反馈建好了 issue');
  const shownBody = github.issues.find((i) => i.body.includes(shown))?.body ?? '';
  const embedded = new RegExp(
    `!\\[[^\\]]*\\]\\((${base}/v1/public/feedback-files/([A-Za-z0-9_-]{43}))\\)`,
  ).exec(shownBody);
  check(Boolean(embedded) && !shownBody.includes(shownFile), 'issue 嵌入了公开链接，没有附件 id');
  const publicUrl = embedded?.[1] ?? '';
  const publicToken = embedded?.[2] ?? '';
  const redirect = await fetch(publicUrl, { redirect: 'manual' });
  const location = redirect.headers.get('location') ?? '';
  check(
    redirect.status === 302 && Number(new URL(location).searchParams.get('X-Amz-Expires')) <= 600,
    '不用登录打开，302 到不超过 10 分钟的签名链接',
  );
  await redirect.body?.cancel();
  const file = await fetch(location);
  check(
    file.headers.get('content-type') === 'image/jpeg' &&
      Buffer.from(await file.arrayBuffer()).equals(bytes),
    '签名链接取到的就是传上去的附件，类型是 image/jpeg',
  );
  const wrong = await fetch(`${base}/v1/public/feedback-files/${'A'.repeat(43)}`, {
    redirect: 'manual',
  });
  await wrong.body?.cancel();
  check(wrong.status === 404, '错的令牌 404');
  const legacyBody = github.issues.find((i) => i.body.includes(id))?.body ?? '';
  check(!legacyBody.includes('/v1/public/feedback-files/'), '没说同意的反馈没有公开链接');
  check(
    !runtime.output().includes(publicToken) && !runtime.output().includes('X-Amz'),
    '函数的日志里没有附件令牌和签名链接',
  );

  console.log('维护者在 App 里看反馈：名单、列表、附件的签名链接');
  const outsider = await request(base, 'GET', '/v1/feedback-inbox', { token: auth.token });
  check(outsider.status === 403, '不在名单里的账号 403');
  const { json: maintainer } = await request<{ token: string }>(base, 'POST', '/v1/auth/register', {
    body: {
      email: FEEDBACK_VIEWER.toUpperCase(),
      password: 'correct horse',
      displayName: '维护者',
    },
  });
  const me = await request<{ canViewFeedback?: boolean }>(base, 'GET', '/v1/me', {
    token: maintainer.token,
  });
  check(me.json.canViewFeedback === true, '/v1/me 说名单里的账号能看');
  const inbox = await request<{
    items: { id: string; text: string; attachments: { id: string }[] }[];
  }>(base, 'GET', '/v1/feedback-inbox?limit=50', { token: maintainer.token });
  const mine = inbox.json.items.find((i) => i.id === id);
  check(
    inbox.status === 200 && mine?.attachments[0]?.id === attachment,
    `列表里有这条反馈和附件（${inbox.ms} ms）`,
  );
  check(!JSON.stringify(inbox.json).includes(email), '列表里没有提交者的邮箱');
  const link = await request<{ url: string; expiresIn: number }>(
    base,
    'GET',
    `/v1/feedback-inbox/${id}/attachments/${attachment}`,
    { token: maintainer.token },
  );
  check(link.status === 200 && link.json.expiresIn <= 600, '附件链接不超过 10 分钟');
  const downloaded = Buffer.from(await (await fetch(link.json.url)).arrayBuffer());
  check(downloaded.equals(bytes), '用链接下载到的就是传上去的附件');
  check(!runtime.output().includes('X-Amz'), '函数的日志里没有签名链接');
}

async function ssrf(base: string, token: string) {
  console.log('SSRF 检查：node:net 和 node:dns 在函数里生效');
  for (const endpoint of [
    'https://127.0.0.1',
    'https://[::ffff:7f00:1]',
    'https://[fd00::1]',
    'https://localhost',
    'http://example.com',
  ]) {
    const refused = await request<{ error: { code: string } }>(base, 'POST', '/v1/storage/test', {
      token,
      body: {
        provider: 'other',
        endpoint,
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
      },
    });
    check(refused.status === 400 && refused.json.error.code === 'bad_endpoint', `拒绝 ${endpoint}`);
  }
}

let failed = false;
try {
  await migrate(sql);
  await ensureBucket(config);
  const port = 18_900 + (process.pid % 90);

  const github = await startFakeGithub(FAKE_GITHUB_TOKEN);
  const permissive = await startRuntime(
    {
      ...functionEnv,
      ALLOW_PRIVATE_STORAGE_ENDPOINTS: 'true',
      FEEDBACK_GITHUB_REPO: 'fictional-owner/fictional-repo',
      FEEDBACK_GITHUB_TOKEN: FAKE_GITHUB_TOKEN,
      FEEDBACK_GITHUB_API_URL: github.url,
      FEEDBACK_VIEWER_EMAILS: ` ${FEEDBACK_VIEWER} `,
      // 反馈附件的公开链接要拼成函数自己的地址，和 startRuntime 里的 base 一样。
      PUBLIC_API_URL: `http://127.0.0.1:${port}/api`,
    },
    port,
  );
  let owner = '';
  try {
    owner = await mainFlow(permissive);
    await appUpdate(permissive.base, owner);
    await publicShare(permissive.base);
    await customStorage(permissive.base, owner);
    await accountLifecycle(permissive.base);
    await feedback(permissive, github);
  } catch (error) {
    console.error(permissive.output());
    throw error;
  } finally {
    await permissive.stop();
    await github.close();
  }

  const strict = await startRuntime(functionEnv, port + 1);
  try {
    await ssrf(strict.base, owner);
  } catch (error) {
    console.error(strict.output());
    throw error;
  } finally {
    await strict.stop();
  }
  console.log('全部通过');
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
}
process.exit(failed ? 1 : 0);
