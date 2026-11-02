import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuthResponse, MeResponse, UploadUrlResponse } from '@xiaodouya/shared';
import type { createApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { connect, migrate, type Sql } from '../src/db';
import { ensureBucket } from '../src/dev-bucket';
import type { Mailer, MailMessage } from '../src/mailer';

export type App = ReturnType<typeof createApp>;

/** 集成测试：真实的 Postgres 和 S3 兼容服务（SeaweedFS），由 pnpm dev:infra 或 CI 提供。 */
export function testEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const line of readFileSync(resolve(import.meta.dirname, '../.env.example'), 'utf8').split(
    '\n',
  )) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1] && !env[match[1]]) env[match[1]] = match[2];
  }
  env.S3_PUBLIC_ENDPOINT = 'http://localhost:59000';
  if (process.env.TEST_S3_ENDPOINT) {
    env.S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;
    env.S3_PUBLIC_ENDPOINT = process.env.TEST_S3_ENDPOINT;
  }
  return env;
}

export interface TestDb {
  sql: Sql;
  config: Config;
  url: string;
  close(): Promise<void>;
}

/** 每个测试文件用独立的数据库：多个 Agent 可能同时跑。 */
export async function openTestDb(suffix: string): Promise<TestDb> {
  const config = loadConfig(testEnv());
  const admin = connect(config.databaseUrl);
  const name = `xiaodouya_test_${process.pid}_${Date.now()}_${suffix}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  const sql = connect(url.toString(), config.db);
  await migrate(sql);
  await ensureBucket(config);
  return {
    sql,
    config,
    url: url.toString(),
    async close() {
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export async function call<T = unknown>(
  app: App,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: T; text: string; headers: Headers }> {
  const response = await app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as T, text, headers: response.headers };
}

export const PASSWORD = 'correct horse';
export const uniqueEmail = () => `user-${randomUUID().slice(0, 12)}@example.test`;

export async function newUser(app: App, displayName = '虚构用户') {
  const email = uniqueEmail();
  const { json } = await call<AuthResponse>(app, 'POST', '/v1/auth/register', {
    body: { email, password: PASSWORD, displayName },
  });
  return { ...json, email };
}

export async function newFamily(app: App, label = '爸爸') {
  const admin = await newUser(app, label);
  const { json } = await call<MeResponse>(app, 'POST', '/v1/families', {
    token: admin.token,
    body: { name: '虚构一家', label },
  });
  return { admin, family: json.family! };
}

export async function join(
  app: App,
  adminToken: string,
  role: 'admin' | 'caregiver' | 'viewer',
  label: string,
) {
  const user = await newUser(app, label);
  const invite = await call<{ code: string }>(app, 'POST', '/v1/invites', {
    token: adminToken,
    body: { role, label },
  });
  const accepted = await call(app, 'POST', '/v1/invites/accept', {
    token: user.token,
    body: { code: invite.json.code },
  });
  if (accepted.status !== 200) throw new Error(`加入失败：${accepted.text}`);
  return user;
}

const BYTES = Buffer.from('xiaodouya-fictional-object');

/** 走真实的预签名上传，返回文件 id。 */
export async function upload(
  app: App,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = (overrides.id as string | undefined) ?? randomUUID();
  const variant = (overrides.variant as string) ?? 'original';
  const { json, status, text } = await call<UploadUrlResponse>(
    app,
    'POST',
    '/v1/media/upload-url',
    {
      token,
      body: {
        id,
        scope: 'memory',
        variant,
        mime: 'image/jpeg',
        size: BYTES.length,
        ...overrides,
      },
    },
  );
  if (status !== 200) throw new Error(`取上传链接失败：${text}`);
  const put = await fetch(json.url, { method: 'PUT', headers: json.headers, body: BYTES });
  if (put.status !== 200) throw new Error(`PUT 失败：${put.status}`);
  const done = await call(app, 'POST', `/v1/media/${id}/complete`, { token, body: { variant } });
  if (done.status !== 200) throw new Error(`完成上传失败：${done.text}`);
  return id;
}

export const OBJECT_BYTES = BYTES;

/** 假的发信器：只把邮件记下来。hold 打开时发信一直挂起，用来证明响应不等邮件。 */
export class FakeMailer implements Mailer {
  messages: MailMessage[] = [];
  fail = false;
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;

  hold() {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  letGo() {
    this.release?.();
    this.gate = null;
  }
  async send(message: MailMessage) {
    if (this.gate) await this.gate;
    if (this.fail) throw new Error('虚构的发送失败');
    this.messages.push(message);
  }
  /** kind 按主题区分：注册时的验证邮件和重置邮件可能同时在途，顺序不确定。 */
  to(email: string, kind?: 'verify' | 'reset') {
    const word = kind === 'verify' ? '邮箱验证码' : kind === 'reset' ? '重置密码' : '';
    return this.messages.filter((m) => m.to === email && m.subject.includes(word));
  }
  lastCode(email: string, kind?: 'verify' | 'reset'): string {
    const text = this.to(email, kind).at(-1)?.text ?? '';
    const code = /\b(\d{6})\b/.exec(text)?.[1];
    if (!code) throw new Error(`没有发给 ${email} 的验证码`);
    return code;
  }
}

/** 收集后台任务，测试里可以等它们做完。 */
export function backgroundTasks() {
  const tasks: Promise<unknown>[] = [];
  return {
    background: (task: Promise<void>) => void tasks.push(task),
    async flush() {
      await Promise.all(tasks);
      tasks.length = 0;
    },
  };
}
