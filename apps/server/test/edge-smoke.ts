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
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config';
import { hashPassword, verifyPassword } from '../src/crypto';
import { connect, migrate } from '../src/db';
import { ensureBucket } from '../src/dev-bucket';

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
};

async function request<T>(
  base: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<{ status: number; json: T; ms: number }> {
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

  return owner;
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

  const permissive = await startRuntime(
    { ...functionEnv, ALLOW_PRIVATE_STORAGE_ENDPOINTS: 'true' },
    port,
  );
  let owner = '';
  try {
    owner = await mainFlow(permissive);
    await customStorage(permissive.base, owner);
  } catch (error) {
    console.error(permissive.output());
    throw error;
  } finally {
    await permissive.stop();
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
