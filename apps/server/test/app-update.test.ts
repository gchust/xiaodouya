import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { type AppUpdateResponse, ReleaseManifest } from '@xiaodouya/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
import { platformStorage, presignDownload } from '../src/storage';
import { call, newFamily, newUser, openTestDb, type TestDb } from './harness';

/**
 * 应用内更新：真实地跑发布脚本 scripts/publish-apk.sh，再从接口取签名链接下载回来。
 * 每个用例用自己的前缀，多个 Agent 同时跑也不会互相覆盖。APK 是随机字节，不是真的 App。
 */
const repo = resolve(import.meta.dirname, '../../..');
const script = resolve(repo, 'scripts/publish-apk.sh');
const work = mkdtempSync(joinPath(tmpdir(), 'xiaodouya-release-'));

let db: TestDb;
let s3: S3Client;
const suffix = `${process.pid}-${Date.now()}`;
let counter = 0;

beforeAll(async () => {
  db = await openTestDb('appupdate');
  const s = db.config.serverStorage!;
  s3 = new S3Client({
    region: s.region,
    endpoint: s.endpoint,
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
  });
});
afterAll(async () => {
  rmSync(work, { recursive: true, force: true });
  await db.close();
});

function fixture() {
  counter += 1;
  const prefix = `releases-test-${suffix}-${counter}/android/`;
  const config: Config = { ...db.config, releasePrefix: prefix };
  return { prefix, config, app: createApp({ sql: db.sql, config }) };
}

function fakeApk(bytes = 200_000) {
  const content = randomBytes(bytes);
  const path = joinPath(work, `fake-${counter}-${bytes}.apk`);
  writeFileSync(path, content);
  return { path, content, sha256: createHash('sha256').update(content).digest('hex') };
}

function publish(
  prefix: string,
  apk: string,
  versionName: string,
  versionCode: number,
  extra: Record<string, string | undefined> = {},
) {
  const s = db.config.serverStorage!;
  return promisify(execFile)('bash', [script, apk, versionName, String(versionCode)], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      S3_ENDPOINT: s.endpoint,
      S3_REGION: s.region,
      S3_BUCKET: s.bucket,
      S3_ACCESS_KEY_ID: s.accessKeyId,
      S3_SECRET_ACCESS_KEY: s.secretAccessKey,
      APP_RELEASE_PREFIX: prefix,
      ...extra,
    },
  });
}

const check = (app: ReturnType<typeof createApp>, token: string | undefined, versionCode: number) =>
  call<AppUpdateResponse>(
    app,
    'GET',
    `/v1/app/update?platform=android&versionCode=${versionCode}`,
    {
      token,
    },
  );

const putManifest = (prefix: string, body: string) =>
  s3.send(
    new PutObjectCommand({
      Bucket: db.config.serverStorage!.bucket,
      Key: `${prefix}latest.json`,
      Body: body,
      ContentType: 'application/json',
    }),
  );

describe('检查更新', () => {
  it('要登录；没有家庭的账号也能查', async () => {
    const { app } = fixture();
    expect((await check(app, undefined, 1)).status).toBe(401);
    const user = await newUser(app);
    const result = await check(app, user.token, 1);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ update: null });
  });

  it('发布后低版本拿到新版本和签名链接，下载回来的就是发布的文件', async () => {
    const { prefix, app } = fixture();
    const apk = fakeApk();
    const { stdout } = await publish(prefix, apk.path, '0.4.0', 120, {
      RELEASE_NOTES_ZH: '修了一些问题',
    });
    expect(stdout).toContain(`${prefix}xiaodouya-0.4.0-120.apk`);
    const { admin } = await newFamily(app);

    const result = await check(app, admin.token, 119);
    expect(result.status).toBe(200);
    const update = result.json.update!;
    expect(update).toMatchObject({
      versionCode: 120,
      versionName: '0.4.0',
      size: apk.content.length,
      sha256: apk.sha256,
      required: false,
      notes: { zh: '修了一些问题' },
    });
    // 短时效：比证件的 10 分钟长一点，够慢速网络开始下载。
    expect(update.expiresIn).toBeLessThanOrEqual(900);
    expect(new URL(update.url).searchParams.get('X-Amz-Expires')).toBe(String(update.expiresIn));
    const download = await fetch(update.url);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(apk.content)).toBe(true);

    // 已经是这个版本或更新：没有更新，也不签链接。
    expect((await check(app, admin.token, 120)).json).toEqual({ update: null });
    expect((await check(app, admin.token, 121)).json).toEqual({ update: null });
  });

  it('清单符合共用的格式定义', async () => {
    const { prefix } = fixture();
    const apk = fakeApk(1000);
    await publish(prefix, apk.path, '0.4.1', 121, { RELEASE_MIN_SUPPORTED_CODE: '100' });
    const object = await fetch(
      await presignDownload(platformStorage(db.config)!, `${prefix}latest.json`, 60),
    );
    const manifest = ReleaseManifest.parse(await object.json());
    expect(manifest).toMatchObject({
      platform: 'android',
      versionCode: 121,
      versionName: '0.4.1',
      minSupportedVersionCode: 100,
      apk: { key: `${prefix}xiaodouya-0.4.1-121.apk`, size: 1000, sha256: apk.sha256 },
    });
  });

  it('低于最低支持版本时标成必须更新', async () => {
    const { prefix, app } = fixture();
    await publish(prefix, fakeApk(1000).path, '0.5.0', 130, { RELEASE_MIN_SUPPORTED_CODE: '125' });
    const user = await newUser(app);
    expect((await check(app, user.token, 124)).json.update?.required).toBe(true);
    expect((await check(app, user.token, 125)).json.update?.required).toBe(false);
  });

  it('清单坏了是 503，不能当成“已经是最新”', async () => {
    const { prefix, app } = fixture();
    const user = await newUser(app);
    await putManifest(prefix, '{"versionCode":');
    const broken = await check(app, user.token, 1);
    expect(broken.status).toBe(503);
    expect(broken.json).toMatchObject({ error: { code: 'update_unavailable' } });
  });

  it('清单指向发布前缀以外的对象时不签链接', async () => {
    const { prefix, app } = fixture();
    const user = await newUser(app);
    await putManifest(
      prefix,
      JSON.stringify({
        platform: 'android',
        versionCode: 999,
        versionName: '9.9.9',
        apk: { key: 'families/someone/original', size: 10, sha256: 'a'.repeat(64) },
        publishedAt: new Date().toISOString(),
      }),
    );
    const result = await check(app, user.token, 1);
    expect(result.status).toBe(503);
    expect(result.text).not.toContain('families/someone');
  });

  it('没有配置默认存储的服务器（自建）不提供更新', async () => {
    const config: Config = { ...db.config, serverStorage: null };
    const app = createApp({ sql: db.sql, config });
    const user = await newUser(app);
    const result = await check(app, user.token, 1);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ update: null });
  });

  it('参数不对是 400', async () => {
    const { app } = fixture();
    const user = await newUser(app);
    for (const query of ['platform=ios&versionCode=1', 'platform=android', 'versionCode=1']) {
      const result = await call(app, 'GET', `/v1/app/update?${query}`, { token: user.token });
      expect(result.status).toBe(400);
    }
  });
});

describe('发布脚本', () => {
  it('缺少存储的 Secret 时直接失败，什么都不写', async () => {
    const { prefix, app } = fixture();
    const failed = await publish(prefix, fakeApk(1000).path, '0.4.0', 120, {
      S3_BUCKET: '',
    }).catch((error: { code: number; stderr: string }) => error);
    expect(failed).toMatchObject({ code: 1 });
    expect((failed as { stderr: string }).stderr).toContain('缺少环境变量 S3_BUCKET');
    const user = await newUser(app);
    expect((await check(app, user.token, 1)).json).toEqual({ update: null });
  });

  it('不覆盖成更低的版本；同一个版本可以重新发布', async () => {
    const { prefix, app } = fixture();
    await publish(prefix, fakeApk(1000).path, '0.4.0', 120);
    const lower = await publish(prefix, fakeApk(1001).path, '0.3.9', 119).catch(
      (error: { code: number; stderr: string }) => error,
    );
    expect(lower).toMatchObject({ code: 1 });
    expect((lower as { stderr: string }).stderr).toContain('不覆盖');
    const again = fakeApk(1002);
    await publish(prefix, again.path, '0.4.0', 120);
    const user = await newUser(app);
    const update = (await check(app, user.token, 1)).json.update!;
    expect(update).toMatchObject({ versionCode: 120, sha256: again.sha256, size: 1002 });
  });

  it('读不了现在的清单（比如密钥错了）时失败，不当成第一次发布', async () => {
    const { prefix, app } = fixture();
    await publish(prefix, fakeApk(1000).path, '0.4.0', 120);
    const failed = await publish(prefix, fakeApk(1003).path, '0.4.1', 121, {
      S3_SECRET_ACCESS_KEY: 'wrong-secret',
    }).catch((error: { code: number; stderr: string }) => error);
    expect(failed).toMatchObject({ code: 1 });
    const user = await newUser(app);
    expect((await check(app, user.token, 1)).json.update?.versionCode).toBe(120);
  });

  it('versionCode 和 versionName 不合法时拒绝', async () => {
    const { prefix } = fixture();
    const apk = fakeApk(1000).path;
    for (const [name, code] of [
      ['0.4.0', '0'],
      ['0.4.0', 'abc'],
      ['0.4.0; rm -rf /', '5'],
      ['', '5'],
    ] as const) {
      const failed = await promisify(execFile)('bash', [script, apk, name, code], {
        env: { PATH: process.env.PATH, APP_RELEASE_PREFIX: prefix },
      }).catch((error: { code: number }) => error);
      expect(failed).toMatchObject({ code: 1 });
    }
  });
});
