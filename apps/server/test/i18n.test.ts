import { type ApiError, defaultPrefs, type MeResponse } from '@xiaodouya/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import {
  backgroundTasks,
  call,
  FakeMailer,
  newUser,
  openTestDb,
  type TestDb,
  uniqueEmail,
} from './harness';

let db: TestDb;
let mail: FakeMailer;
let bg: ReturnType<typeof backgroundTasks>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await openTestDb('i18n');
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.sql`DELETE FROM rate_limits`;
  mail = new FakeMailer();
  bg = backgroundTasks();
  app = createApp({ sql: db.sql, config: db.config, mailer: mail, background: bg.background });
});

const CHINESE = /[一-鿿]/;

async function forgotMail(email: string, header?: string) {
  await call(app, 'POST', '/v1/auth/password/forgot', {
    body: { email },
    headers: header ? { 'accept-language': header } : undefined,
  });
  await bg.flush();
  const message = mail.messages.at(-1);
  if (!message || message.to !== email) throw new Error('没有发信');
  return message;
}

async function setLocale(token: string, locale: 'zh' | 'en') {
  const { status } = await call(app, 'PUT', '/v1/me/prefs', {
    token,
    body: { ...defaultPrefs, locale },
  });
  expect(status).toBe(200);
}

describe('验证码邮件的语言', () => {
  it('没有偏好也没有请求头（v0.1.0）时是中文', async () => {
    const user = await newUser(app);
    const message = await forgotMail(user.email);
    expect(message.subject).toMatch(CHINESE);
    expect(message.text).toMatch(CHINESE);
  });

  it('没有偏好时按请求头，zh 开头的中文，其他英文', async () => {
    const user = await newUser(app);
    const en = await forgotMail(user.email, 'en-US');
    expect(en.subject).toContain('Xiaodouya');
    expect(en.subject).not.toMatch(CHINESE);
    expect(en.text).not.toMatch(CHINESE);
    await db.sql`UPDATE email_codes SET created_at = created_at - interval '2 minutes'`;
    expect((await forgotMail(user.email, 'fr-FR')).subject).not.toMatch(CHINESE);
    await db.sql`UPDATE email_codes SET created_at = created_at - interval '2 minutes'`;
    expect((await forgotMail(user.email, 'zh-CN')).subject).toMatch(CHINESE);
  });

  it('收件人选过语言时优先于请求头：别人替他点找回密码也按他的语言', async () => {
    const user = await newUser(app);
    await setLocale(user.token, 'en');
    expect((await forgotMail(user.email, 'zh-CN')).subject).not.toMatch(CHINESE);
    await setLocale(user.token, 'zh');
    await db.sql`UPDATE email_codes SET created_at = created_at - interval '2 minutes'`;
    expect((await forgotMail(user.email, 'en')).subject).toMatch(CHINESE);
  });

  it('注册时的验证邮件按请求头，验证码在正文里', async () => {
    const email = uniqueEmail();
    await call(app, 'POST', '/v1/auth/register', {
      body: { email, password: 'long enough password', displayName: 'A fictional parent' },
      headers: { 'accept-language': 'en' },
    });
    await bg.flush();
    const message = mail.messages.at(-1);
    expect(message?.to).toBe(email);
    expect(message?.text).toMatch(/\b\d{6}\b/);
    expect(message?.subject).not.toMatch(CHINESE);
  });

  it('重新发送验证码按账号的语言', async () => {
    const user = await newUser(app);
    await bg.flush();
    await setLocale(user.token, 'en');
    await db.sql`UPDATE email_codes SET created_at = created_at - interval '2 minutes'`;
    const before = mail.messages.length;
    await call(app, 'POST', '/v1/me/email/send-code', { token: user.token });
    await bg.flush();
    expect(mail.messages.length).toBe(before + 1);
    expect(mail.messages.at(-1)?.subject).not.toMatch(CHINESE);
  });
});

describe('偏好里的语言', () => {
  it('能存能读，不认识的值丢掉，其他偏好不受影响', async () => {
    const user = await newUser(app);
    await setLocale(user.token, 'en');
    const me = await call<MeResponse>(app, 'GET', '/v1/me', { token: user.token });
    expect(me.json.prefs.locale).toBe('en');
    await call(app, 'PUT', '/v1/me/prefs', {
      token: user.token,
      body: { ...defaultPrefs, locale: 'fr', videoWifiOnly: false },
    });
    const after = await call<MeResponse>(app, 'GET', '/v1/me', { token: user.token });
    expect(after.json.prefs.locale).toBeUndefined();
    expect(after.json.prefs.videoWifiOnly).toBe(false);
  });
});

describe('错误响应继续兼容 v0.1.0', () => {
  it('code 和中文 message 不变，v0.1.0 直接显示 message', async () => {
    const res = await call<ApiError>(app, 'POST', '/v1/auth/login', {
      body: { email: uniqueEmail(), password: 'wrong password here' },
    });
    expect(res.status).toBe(401);
    expect(res.json.error).toEqual({ code: 'bad_credentials', message: '邮箱或密码不正确' });
  });

  it('带参数的消息把参数放在可选字段里，message 还是原来那句中文', async () => {
    const user = await newUser(app);
    const res = await call<ApiError>(app, 'POST', '/v1/media/upload-url', {
      token: user.token,
      body: { id: crypto.randomUUID(), mime: 'image/jpeg', size: 1, scope: 'moment' },
    });
    // 这个账号没有家庭。
    expect(res.json.error.code).toBe('no_family');
    expect(res.json.error.message).toBe('还没有加入家庭');
    expect(res.json.error.params).toBeUndefined();
  });

  it('尝试次数太多：message 写 15 分钟，params 带分钟数', async () => {
    const user = await newUser(app);
    for (let i = 0; i < 12; i += 1) {
      await call(app, 'POST', '/v1/auth/login', {
        body: { email: user.email, password: 'wrong password here' },
      });
    }
    const res = await call<ApiError>(app, 'POST', '/v1/auth/login', {
      body: { email: user.email, password: 'wrong password here' },
    });
    expect(res.status).toBe(429);
    expect(res.json.error.message).toBe('尝试次数太多了，请 15 分钟后再试');
    expect(res.json.error.params).toEqual({ minutes: 15 });
  });
});
