import { randomUUID } from 'node:crypto';
import type { AuthResponse, MeResponse, PublicConfig } from '@xiaodouya/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createEdgeHandler } from '../src/edge';
import { createMailer, logMailer, resendMailer } from '../src/mailer';
import {
  type App,
  backgroundTasks,
  call,
  FakeMailer,
  newFamily,
  newUser,
  openTestDb,
  PASSWORD,
  type TestDb,
  testEnv,
  uniqueEmail,
} from './harness';

const NEW_PASSWORD = 'a brand new password';

let db: TestDb;
let mail: FakeMailer;
let bg: ReturnType<typeof backgroundTasks>;
let app: App;
let plainApp: App;

beforeAll(async () => {
  db = await openTestDb('acct');
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  // 按来源的限流在测试里都算同一个来源，每条测试各算各的。
  await db.sql`DELETE FROM rate_limits`;
  mail = new FakeMailer();
  bg = backgroundTasks();
  app = createApp({ sql: db.sql, config: db.config, mailer: mail, background: bg.background });
  plainApp = createApp({ sql: db.sql, config: db.config });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const forgot = (email: string, headers?: Record<string, string>) =>
  call(app, 'POST', '/v1/auth/password/forgot', { body: { email }, headers });
const reset = (
  email: string,
  code: string,
  newPassword = NEW_PASSWORD,
  headers?: Record<string, string>,
) =>
  call<{ error?: { code: string } }>(app, 'POST', '/v1/auth/password/reset', {
    body: { email, code, newPassword },
    headers,
  });
const login = (email: string, password: string) =>
  call<AuthResponse>(app, 'POST', '/v1/auth/login', { body: { email, password } });
const me = (token: string, target = app) => call<MeResponse>(target, 'GET', '/v1/me', { token });

/** 冷却只看 created_at，测试里把它往前拨，不用真的等。 */
const skipCooldown = () =>
  db.sql`UPDATE email_codes SET created_at = created_at - interval '2 minutes'`;

async function forgotCode(email: string) {
  await forgot(email);
  await bg.flush();
  return mail.lastCode(email, 'reset');
}

const wrongCode = (right: string) => (right === '000000' ? '111111' : '000000');

describe('邮件配置', () => {
  it('公开的 /v1/config 不需要登录，只说开了什么', async () => {
    const on = await call<PublicConfig>(app, 'GET', '/v1/config');
    expect(on.status).toBe(200);
    expect(on.json).toEqual({
      allowCustomStorage: db.config.allowCustomStorage,
      passwordReset: true,
      emailVerification: true,
    });
    const off = await call<PublicConfig>(plainApp, 'GET', '/v1/config');
    expect(off.status).toBe(200);
    expect(off.json).toEqual({
      allowCustomStorage: db.config.allowCustomStorage,
      passwordReset: false,
      emailVerification: false,
    });
  });

  it('Edge Function 的路径前缀下也能访问 /v1/config', async () => {
    const edge = createApp({ sql: db.sql, config: db.config, basePath: '/api' });
    expect((await call(edge, 'GET', '/api/v1/config')).status).toBe(200);
  });

  const envWith = (extra: Record<string, string>) => ({ ...testEnv(), ...extra });

  it('默认不发邮件', () => {
    expect(loadConfig(envWith({ NODE_ENV: 'production' })).mail).toBeNull();
    expect(loadConfig(envWith({ MAIL_PROVIDER: '' })).mail).toBeNull();
    expect(loadConfig(envWith({ MAIL_PROVIDER: 'none' })).mail).toBeNull();
    expect(createMailer(null)).toBeNull();
  });

  it('log 只能用于开发，生产环境拒绝启动', () => {
    expect(loadConfig(envWith({ MAIL_PROVIDER: 'log', NODE_ENV: 'development' })).mail).toEqual({
      provider: 'log',
    });
    expect(() => loadConfig(envWith({ MAIL_PROVIDER: 'log', NODE_ENV: 'production' }))).toThrow(
      /MAIL_PROVIDER/,
    );
  });

  it('Edge Function 上没有 NODE_ENV，也不能用 log：验证码会进云端日志', () => {
    const env = { ...testEnv(), MAIL_PROVIDER: 'log', NODE_ENV: undefined };
    expect(() => createEdgeHandler(env, () => {})).toThrow(/MAIL_PROVIDER/);
    expect(() => createEdgeHandler({ ...env, NODE_ENV: 'development' }, () => {})).toThrow(
      /MAIL_PROVIDER/,
    );
  });

  it('resend 缺密钥或发件人时拒绝启动，不能悄悄关掉邮件', () => {
    expect(() => loadConfig(envWith({ MAIL_PROVIDER: 'resend' }))).toThrow(/RESEND_API_KEY/);
    expect(() =>
      loadConfig(envWith({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_fictional' })),
    ).toThrow(/MAIL_FROM/);
    const ok = loadConfig(
      envWith({
        MAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_fictional',
        MAIL_FROM: '小豆芽 <no-reply@example.test>',
      }),
    );
    expect(ok.mail).toEqual({
      provider: 'resend',
      apiKey: 're_fictional',
      from: '小豆芽 <no-reply@example.test>',
    });
  });

  it('拼错的 MAIL_PROVIDER 拒绝启动', () => {
    expect(() => loadConfig(envWith({ MAIL_PROVIDER: 'sendgrid' }))).toThrow(/MAIL_PROVIDER/);
  });

  it('resend 按 API 文档发请求', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"id":"x"}', { status: 200 }));
    await resendMailer('re_fictional', 'a@example.test', fetchImpl).send({
      to: 'b@example.test',
      subject: '主题',
      text: '正文',
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer re_fictional');
    expect(JSON.parse(init?.body as string)).toEqual({
      from: 'a@example.test',
      to: 'b@example.test',
      subject: '主题',
      text: '正文',
    });
  });

  it('resend 失败时报错只带状态码，不带密钥和对方返回的内容', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('回显 b@example.test 123456', { status: 422 }),
    );
    const sending = resendMailer('re_fictional', 'a@example.test', fetchImpl).send({
      to: 'b@example.test',
      subject: '主题',
      text: '123456',
    });
    const error = (await sending.catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('422');
    expect(error.message).not.toContain('re_fictional');
    expect(error.message).not.toContain('123456');
    expect(error.message).not.toContain('b@example.test');
  });

  it('log 发信器把验证码打到本地终端', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await logMailer().send({ to: 'b@example.test', subject: '主题', text: '验证码 654321' });
    expect(log.mock.calls.flat().join(' ')).toContain('654321');
  });
});

describe('找回密码', () => {
  it('凭邮件里的验证码改密码：旧密码失效，新密码可用，所有设备都要重新登录', async () => {
    const user = await newUser(app);
    const another = await login(user.email, PASSWORD);
    const code = await forgotCode(user.email);
    const done = await reset(user.email, code);
    expect(done.status).toBe(200);
    expect((await login(user.email, PASSWORD)).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    const revoked = await me(user.token);
    expect(revoked.status).toBe(401);
    expect((await me(another.json.token)).status).toBe(401);
  });

  it('改密码证明了邮箱属于本人，顺带算作验证过', async () => {
    const user = await newUser(app);
    expect((await me(user.token)).json.emailVerified).toBe(false);
    const code = await forgotCode(user.email);
    await reset(user.email, code);
    const after = await login(user.email, NEW_PASSWORD);
    expect((await me(after.json.token)).json.emailVerified).toBe(true);
  });

  it('改密码后之前猜错密码的限流也解除，否则本人还是登录不了', async () => {
    const user = await newUser(app);
    for (let i = 0; i < 11; i++) await login(user.email, 'wrong-pass');
    expect((await login(user.email, PASSWORD)).status).toBe(429);
    await reset(user.email, await forgotCode(user.email));
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  describe('不能用来判断邮箱有没有注册', () => {
    it('申请验证码：状态码、响应内容和响应头完全一样', async () => {
      const user = await newUser(app);
      await bg.flush();
      const before = mail.messages.length;
      const real = await forgot(user.email);
      const fake = await forgot(uniqueEmail());
      await bg.flush();
      expect(real.status).toBe(200);
      expect(fake.status).toBe(real.status);
      expect(fake.text).toBe(real.text);
      expect([...fake.headers.entries()].sort()).toEqual([...real.headers.entries()].sort());
      expect(mail.messages.length).toBe(before + 1);
    });

    it('响应不等发信：邮件服务再慢，也看不出邮箱是否存在', async () => {
      const user = await newUser(app);
      await bg.flush();
      mail.hold();
      const response = await Promise.race([
        forgot(user.email),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
      ]);
      expect(response).not.toBe('timeout');
      expect((response as { status: number }).status).toBe(200);
      expect(mail.to(user.email, 'reset')).toHaveLength(0);
      mail.letGo();
      await bg.flush();
      expect(mail.to(user.email, 'reset')).toHaveLength(1);
    });

    it('发信失败时响应还是一样，而且不会变成未处理的拒绝', async () => {
      const user = await newUser(app);
      await bg.flush();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mail.fail = true;
      const response = await forgot(user.email);
      expect(response.status).toBe(200);
      await expect(bg.flush()).resolves.toBeUndefined();
    });

    it('提交验证码：邮箱不存在、验证码错、过期、用过、没申请过，响应完全一样', async () => {
      const results = [];
      results.push(await reset(uniqueEmail(), '123456'));

      const neverAsked = await newUser(app);
      results.push(await reset(neverAsked.email, '123456'));

      const wrong = await newUser(app);
      const wrongRight = await forgotCode(wrong.email);
      results.push(await reset(wrong.email, wrongCode(wrongRight)));

      const expired = await newUser(app);
      const expiredCode = await forgotCode(expired.email);
      await db.sql`UPDATE email_codes SET expires_at = now() - interval '1 second'
        WHERE user_id = ${expired.user.id}`;
      results.push(await reset(expired.email, expiredCode));

      const used = await newUser(app);
      const usedCode = await forgotCode(used.email);
      expect((await reset(used.email, usedCode)).status).toBe(200);
      results.push(await reset(used.email, usedCode));

      for (const result of results) {
        expect(result.status).toBe(400);
        expect(result.text).toBe(results[0]?.text);
      }
      expect(results[0]?.json.error?.code).toBe('invalid_code');
    });

    it('按来源的限流只看请求次数，真假邮箱一样', async () => {
      const user = await newUser(app);
      const headers = { 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}` };
      for (let i = 0; i < 20; i++) expect((await forgot(uniqueEmail(), headers)).status).toBe(200);
      const real = await forgot(user.email, headers);
      const fake = await forgot(uniqueEmail(), headers);
      expect(real.status).toBe(429);
      expect(fake.status).toBe(429);
      expect(fake.text).toBe(real.text);
    });

    it('登录时邮箱不存在也要算一遍哈希，否则响应时间就暴露了邮箱是否存在', async () => {
      const user = await newUser(app);
      const timed = async (email: string) => {
        const started = performance.now();
        expect((await login(email, 'wrong-pass')).status).toBe(401);
        return performance.now() - started;
      };
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[1] ?? 0;
      const existing = median([
        await timed(user.email),
        await timed(user.email),
        await timed(user.email),
      ]);
      const missing = median([
        await timed(uniqueEmail()),
        await timed(uniqueEmail()),
        await timed(uniqueEmail()),
      ]);
      // 修复前约 0.25 倍。查询本身也占时间，所以不要求接近 1。
      expect(missing).toBeGreaterThan(existing * 0.6);
    });
  });

  it('验证码错了不会改密码', async () => {
    const user = await newUser(app);
    const code = await forgotCode(user.email);
    expect((await reset(user.email, wrongCode(code))).status).toBe(400);
    expect((await login(user.email, PASSWORD)).status).toBe(200);
    expect((await me(user.token)).status).toBe(200);
  });

  it('过期的验证码不能用，有效期约 30 分钟', async () => {
    const user = await newUser(app);
    const code = await forgotCode(user.email);
    const [row] = await db.sql<{ minutes: number }[]>`
      SELECT extract(epoch FROM expires_at - now()) / 60 AS minutes FROM email_codes
      WHERE user_id = ${user.user.id} AND purpose = 'reset_password'`;
    expect(Number(row?.minutes)).toBeGreaterThan(29);
    expect(Number(row?.minutes)).toBeLessThanOrEqual(30);
    await db.sql`UPDATE email_codes SET expires_at = now() - interval '1 second'
      WHERE user_id = ${user.user.id} AND purpose = 'reset_password'`;
    expect((await reset(user.email, code)).status).toBe(400);
    expect((await login(user.email, PASSWORD)).status).toBe(200);
  });

  it('验证码只能用一次，同时提交也只有一个成功', async () => {
    const user = await newUser(app);
    const code = await forgotCode(user.email);
    const results = await Promise.all([
      reset(user.email, code, 'first new password'),
      reset(user.email, code, 'second new password'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await reset(user.email, code, 'third new password')).status).toBe(400);
  });

  it('猜错 5 次后验证码作废，正确的也不行', async () => {
    const user = await newUser(app);
    const code = await forgotCode(user.email);
    for (let i = 0; i < 5; i++) await reset(user.email, wrongCode(code));
    expect((await reset(user.email, code)).status).toBe(400);
    expect((await login(user.email, PASSWORD)).status).toBe(200);
  });

  it('猜错 4 次后，正确的验证码还能用', async () => {
    const user = await newUser(app);
    const code = await forgotCode(user.email);
    for (let i = 0; i < 4; i++) await reset(user.email, wrongCode(code));
    expect((await reset(user.email, code)).status).toBe(200);
  });

  it('同时猜也不能超过次数上限', async () => {
    const user = await newUser(app);
    const code = await forgotCode(user.email);
    await Promise.all(Array.from({ length: 12 }, () => reset(user.email, wrongCode(code))));
    const [row] = await db.sql<{ attempts: number }[]>`
      SELECT attempts FROM email_codes WHERE user_id = ${user.user.id} AND purpose = 'reset_password'`;
    expect(row?.attempts).toBe(5);
  });

  it('换验证码也绕不过同一个邮箱的总次数限制，真假邮箱一样', async () => {
    const user = await newUser(app);
    let code = await forgotCode(user.email);
    let lastReal = 0;
    for (let i = 0; i < 21; i++) {
      if (i % 5 === 4) {
        await skipCooldown();
        code = await forgotCode(user.email);
      }
      lastReal = (await reset(user.email, wrongCode(code))).status;
    }
    expect(lastReal).toBe(429);
    const missing = uniqueEmail();
    let lastFake = 0;
    for (let i = 0; i < 21; i++) lastFake = (await reset(missing, '123456')).status;
    expect(lastFake).toBe(429);
  }, 60_000);

  it('新验证码发出后旧的立刻作废', async () => {
    const user = await newUser(app);
    const first = await forgotCode(user.email);
    await skipCooldown();
    await forgot(user.email);
    await bg.flush();
    const second = mail.lastCode(user.email, 'reset');
    if (first !== second) expect((await reset(user.email, first)).status).toBe(400);
    expect((await reset(user.email, second)).status).toBe(200);
  });

  it('冷却期内重复申请不发第二封，响应一样', async () => {
    const user = await newUser(app);
    const first = await forgot(user.email);
    const second = await forgot(user.email);
    await bg.flush();
    expect(second.text).toBe(first.text);
    expect(second.status).toBe(200);
    expect(mail.to(user.email, 'reset')).toHaveLength(1);
  });

  it('同一个邮箱超过发送上限后不再发信，响应不变：不能用来轰炸别人的邮箱', async () => {
    const user = await newUser(app);
    for (let i = 0; i < 8; i++) {
      await skipCooldown();
      expect((await forgot(user.email)).status).toBe(200);
      await bg.flush();
    }
    expect(mail.to(user.email, 'reset')).toHaveLength(5);
  });

  it('数据库里不是明文，也不是能撞出来的无密钥哈希', async () => {
    const user = await newUser(app);
    const code = await forgotCode(user.email);
    const [row] = await db.sql<{ code_hash: string }[]>`
      SELECT code_hash FROM email_codes WHERE user_id = ${user.user.id} AND purpose = 'reset_password'`;
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.code_hash).not.toContain(code);
    const { sha256 } = await import('../src/crypto');
    expect(row?.code_hash).not.toBe(sha256(code));
  });

  it('任何路径下都不把验证码写进日志', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    const user = await newUser(app);
    const code = await forgotCode(user.email);
    await reset(user.email, wrongCode(code));
    await reset(user.email, code, 'short');
    await reset(user.email, code);
    mail.fail = true;
    await skipCooldown();
    await forgot(user.email);
    await bg.flush();
    const output = lines.join('\n');
    expect(output).not.toContain(code);
    expect(output).not.toContain(NEW_PASSWORD);
    expect(output).not.toContain(user.email);
  });

  it('新密码太短被拒绝，验证码不受影响', async () => {
    const user = await newUser(app);
    const code = await forgotCode(user.email);
    expect((await reset(user.email, code, 'short')).status).toBe(400);
    expect((await reset(user.email, code)).status).toBe(200);
  });

  it('没有配置邮件时明确说不支持，和邮箱是否存在无关', async () => {
    const user = await newUser(plainApp);
    const real = await call(plainApp, 'POST', '/v1/auth/password/forgot', {
      body: { email: user.email },
    });
    const fake = await call(plainApp, 'POST', '/v1/auth/password/forgot', {
      body: { email: uniqueEmail() },
    });
    expect(real.status).toBe(503);
    expect(fake.text).toBe(real.text);
    const submit = await call(plainApp, 'POST', '/v1/auth/password/reset', {
      body: { email: user.email, code: '123456', newPassword: NEW_PASSWORD },
    });
    expect(submit.status).toBe(503);
  });
});

describe('邮箱验证', () => {
  const verify = (token: string, code: string) =>
    call<MeResponse & { error?: { code: string } }>(app, 'POST', '/v1/me/email/verify', {
      token,
      body: { code },
    });
  const sendCode = (token: string) =>
    call<{ emailVerified: boolean; retryAfterSeconds: number }>(
      app,
      'POST',
      '/v1/me/email/send-code',
      { token },
    );
  const createFamily = (token: string, target = app) =>
    call<MeResponse & { error?: { code: string } }>(target, 'POST', '/v1/families', {
      token,
      body: { name: '虚构一家', label: '爸爸' },
    });

  async function registered() {
    const user = await newUser(app);
    await bg.flush();
    return { ...user, code: mail.lastCode(user.email, 'verify') };
  }

  it('注册时发 6 位验证码，验证后 emailVerified 变成 true', async () => {
    const user = await registered();
    expect(user.code).toMatch(/^\d{6}$/);
    const before = await me(user.token);
    expect(before.json.emailVerified).toBe(false);
    const done = await verify(user.token, user.code);
    expect(done.status).toBe(200);
    expect(done.json.emailVerified).toBe(true);
    expect((await me(user.token)).json.emailVerified).toBe(true);
  });

  describe('线上的 v0.1.0 APK 不知道邮箱验证，打开邮件后也不能被锁在外面', () => {
    it('只走旧接口：注册、建家庭、邀请、加入、同步全部照常', async () => {
      const owner = await newUser(app);
      const family = await createFamily(owner.token);
      expect(family.status).toBe(201);
      const invite = await call<{ code: string }>(app, 'POST', '/v1/invites', {
        token: owner.token,
        body: { role: 'caregiver', label: '妈妈' },
      });
      expect(invite.status).toBe(201);
      const member = await newUser(app);
      const joined = await call(app, 'POST', '/v1/invites/accept', {
        token: member.token,
        body: { code: invite.json.code },
      });
      expect(joined.status).toBe(200);
      for (const token of [owner.token, member.token]) {
        const synced = await call(app, 'POST', '/v1/sync', {
          token,
          body: { cursor: 0, changes: [] },
        });
        expect(synced.status).toBe(200);
      }
    });

    it('注册和登录的响应结构不变，/v1/me 只是多了字段', async () => {
      const email = uniqueEmail();
      const registeredResponse = await call<AuthResponse>(app, 'POST', '/v1/auth/register', {
        body: { email, password: PASSWORD, displayName: '虚构用户' },
      });
      expect(Object.keys(registeredResponse.json).sort()).toEqual(['token', 'user']);
      expect(Object.keys(registeredResponse.json.user).sort()).toEqual([
        'displayName',
        'email',
        'id',
      ]);
      const loggedIn = await login(email, PASSWORD);
      expect(Object.keys(loggedIn.json).sort()).toEqual(['token', 'user']);
      const profile = await me(loggedIn.json.token);
      for (const key of ['user', 'family', 'role', 'label', 'members', 'invites', 'prefs']) {
        expect(profile.json).toHaveProperty(key);
      }
    });
  });

  describe('打开邮件之前注册的老账号', () => {
    /** 老账号：没配邮件时注册的，从来没有验证过，也没有验证码。 */
    const existing = async () => {
      const user = await newUser(plainApp);
      const [row] = await db.sql<{ email_verified_at: Date | null }[]>`
        SELECT email_verified_at FROM users WHERE id = ${user.user.id}`;
      expect(row?.email_verified_at).toBeNull();
      return user;
    };

    it('没有家庭也能直接建家庭，不会被拦', async () => {
      const user = await existing();
      expect((await me(user.token)).json.emailVerified).toBe(false);
      expect((await createFamily(user.token)).status).toBe(201);
    });

    it('已经有家庭的，同步照常，可以随时自己选择验证', async () => {
      const { admin } = await newFamily(plainApp);
      expect((await me(admin.token)).json.emailVerified).toBe(false);
      const send = await call<{ retryAfterSeconds: number }>(
        app,
        'POST',
        '/v1/me/email/send-code',
        { token: admin.token },
      );
      expect(send.json.retryAfterSeconds).toBe(60);
      await bg.flush();
      const done = await verify(admin.token, mail.lastCode(admin.email, 'verify'));
      expect(done.status).toBe(200);
      expect(done.json.emailVerified).toBe(true);
      expect(done.json.family).not.toBeNull();
    });

    it('没验证过也能找回密码：不能因为没验证就把人关在外面', async () => {
      const user = await existing();
      expect((await reset(user.email, await forgotCode(user.email))).status).toBe(200);
      expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    });
  });

  it('Supabase 没有设置邮件 Secret 时函数正常启动，走跳过的路径', async () => {
    const env = { ...testEnv(), MAIL_PROVIDER: undefined, RESEND_API_KEY: undefined };
    const handler = createEdgeHandler(env, () => {});
    expect(handler).toBeTypeOf('function');
    const response = await handler(new Request('http://localhost/api/v1/config'));
    expect(await response.json()).toMatchObject({
      passwordReset: false,
      emailVerification: false,
    });
  });

  it('没有配置邮件时跳过这一步：不发信，算作已验证，直接建家庭', async () => {
    const user = await newUser(plainApp);
    expect((await me(user.token, plainApp)).json.emailVerified).toBe(true);
    expect((await createFamily(user.token, plainApp)).status).toBe(201);
    const send = await call(plainApp, 'POST', '/v1/me/email/send-code', { token: user.token });
    expect(send.status).toBe(503);
  });

  it('验证码错误、过期、用过都不行', async () => {
    const wrong = await registered();
    const rejected = await verify(wrong.token, wrongCode(wrong.code));
    expect(rejected.status).toBe(400);
    expect(rejected.json.error?.code).toBe('invalid_code');
    expect((await me(wrong.token)).json.emailVerified).toBe(false);

    const expired = await registered();
    await db.sql`UPDATE email_codes SET expires_at = now() - interval '1 second'
      WHERE user_id = ${expired.user.id}`;
    expect((await verify(expired.token, expired.code)).status).toBe(400);

    const used = await registered();
    expect((await verify(used.token, used.code)).status).toBe(200);
    const [left] = await db.sql<{ count: string }[]>`
      SELECT count(*) FROM email_codes WHERE user_id = ${used.user.id}`;
    expect(Number(left?.count)).toBe(0);
  });

  it('猜错 5 次后验证码作废，重新发一个才行', async () => {
    const user = await registered();
    for (let i = 0; i < 5; i++) await verify(user.token, wrongCode(user.code));
    expect((await verify(user.token, user.code)).status).toBe(400);
    await skipCooldown();
    await sendCode(user.token);
    await bg.flush();
    expect((await verify(user.token, mail.lastCode(user.email))).status).toBe(200);
  });

  it('重发有冷却，服务端告诉 App 还要等多久，冷却结束后旧验证码作废', async () => {
    const user = await registered();
    const tooSoon = await sendCode(user.token);
    expect(tooSoon.status).toBe(200);
    expect(tooSoon.json.retryAfterSeconds).toBeGreaterThan(0);
    expect(tooSoon.json.retryAfterSeconds).toBeLessThanOrEqual(60);
    await bg.flush();
    expect(mail.to(user.email)).toHaveLength(1);
    await skipCooldown();
    const again = await sendCode(user.token);
    expect(again.json.retryAfterSeconds).toBe(60);
    await bg.flush();
    expect(mail.to(user.email)).toHaveLength(2);
    const fresh = mail.lastCode(user.email);
    if (fresh !== user.code) expect((await verify(user.token, user.code)).status).toBe(400);
    expect((await verify(user.token, fresh)).status).toBe(200);
  });

  it('重发次数有上限', async () => {
    const user = await registered();
    let last = 200;
    for (let i = 0; i < 6; i++) {
      await skipCooldown();
      last = (await sendCode(user.token)).status;
    }
    expect(last).toBe(429);
  });

  it('已经验证过再申请，不发信', async () => {
    const user = await registered();
    await verify(user.token, user.code);
    const send = await sendCode(user.token);
    expect(send.json).toEqual({ emailVerified: true, retryAfterSeconds: 0 });
    await bg.flush();
    expect(mail.to(user.email)).toHaveLength(1);
  });

  it('两种验证码不能混用', async () => {
    const user = await registered();
    await db.sql`DELETE FROM email_codes WHERE user_id = ${user.user.id} AND purpose = 'reset_password'`;
    const resetCode = await forgotCode(user.email);
    expect((await verify(user.token, resetCode)).status).toBe(400);

    const other = await registered();
    expect((await reset(other.email, other.code)).status).toBe(400);
  });

  it('发信失败不影响注册', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mail.fail = true;
    const email = uniqueEmail();
    const response = await call<AuthResponse>(app, 'POST', '/v1/auth/register', {
      body: { email, password: PASSWORD, displayName: randomUUID().slice(0, 8) },
    });
    expect(response.status).toBe(201);
    await expect(bg.flush()).resolves.toBeUndefined();
  });

  /** 注册本身的按来源限制关掉，只看发信这一条。 */
  const withoutRegisterLimit = () =>
    createApp({
      sql: db.sql,
      config: { ...db.config, limits: { ...db.config.limits, registerPerIpHour: 0 } },
      mailer: mail,
      background: bg.background,
    });
  const registerMany = async (target: App, count: number, headers?: Record<string, string>) => {
    for (let i = 0; i < count; i++) {
      const response = await call(target, 'POST', '/v1/auth/register', {
        body: { email: uniqueEmail(), password: PASSWORD, displayName: '虚构用户' },
        headers,
      });
      expect(response.status).toBe(201);
    }
    await bg.flush();
  };

  it('用同一个来源大量注册不能变成群发：超过上限后注册还成功，但不发信', async () => {
    const headers = { 'x-forwarded-for': `192.0.2.${Math.floor(Math.random() * 250) + 1}` };
    await registerMany(withoutRegisterLimit(), 21, headers);
    expect(mail.messages).toHaveLength(20);
  }, 60_000);

  it('拿不到来源时不按来源限制发信：大家不能共用一个计数', async () => {
    await registerMany(withoutRegisterLimit(), 21);
    expect(mail.messages).toHaveLength(21);
    const proxied = { 'x-forwarded-for': '10.0.0.1' };
    await registerMany(withoutRegisterLimit(), 1, proxied);
    expect(mail.messages).toHaveLength(22);
  }, 60_000);
});

describe('拿不到来源地址时的限流', () => {
  it('找回密码不共用一个计数，一个人挡不住所有人', async () => {
    for (const headers of [undefined, { 'x-forwarded-for': '10.0.0.1' }]) {
      for (let i = 0; i < 21; i++) {
        expect((await forgot(uniqueEmail(), headers)).status).toBe(200);
      }
    }
    await bg.flush();
  }, 60_000);

  it('按邮箱的发送上限还在', async () => {
    const user = await newUser(app);
    for (let i = 0; i < 7; i++) {
      await skipCooldown();
      await forgot(user.email);
      await bg.flush();
    }
    expect(mail.to(user.email, 'reset')).toHaveLength(5);
  });

  it('提交验证码按 unknown 加邮箱计数，只影响这一个邮箱', async () => {
    const victim = uniqueEmail();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await reset(victim, '123456')).status;
    expect(last).toBe(429);
    expect((await reset(uniqueEmail(), '123456')).status).toBe(400);
  }, 60_000);
});

describe('改密码后清除登录限流，键要和登录时算出来的完全一样', () => {
  const loginFrom = (email: string, password: string, headers?: Record<string, string>) =>
    call<AuthResponse>(app, 'POST', '/v1/auth/login', { body: { email, password }, headers });

  async function lockOutThenReset(headers?: Record<string, string>) {
    const user = await newUser(app);
    for (let i = 0; i < 11; i++) await loginFrom(user.email, 'wrong-pass', headers);
    expect((await loginFrom(user.email, PASSWORD, headers)).status).toBe(429);
    await forgot(user.email, headers);
    await bg.flush();
    const done = await reset(user.email, mail.lastCode(user.email, 'reset'), NEW_PASSWORD, headers);
    expect(done.status).toBe(200);
    expect((await loginFrom(user.email, NEW_PASSWORD, headers)).status).toBe(200);
  }

  it('有来源地址时', async () => {
    await lockOutThenReset({ 'x-forwarded-for': '203.0.113.7' });
  });

  it('拿不到来源地址时（unknown）', async () => {
    await lockOutThenReset();
  });

  it('代理追加的地址：取同一段', async () => {
    await lockOutThenReset({ 'x-forwarded-for': '198.51.100.1, 203.0.113.8' });
  });

  it('只清除本人这一个邮箱的限流', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    const other = await newUser(app);
    for (let i = 0; i < 11; i++) await loginFrom(other.email, 'wrong-pass', headers);
    await lockOutThenReset(headers);
    expect((await loginFrom(other.email, PASSWORD, headers)).status).toBe(429);
  });
});
