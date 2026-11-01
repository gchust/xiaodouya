import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../src/config';
import { connect, migrate, type Sql } from '../src/db';
import { ensureBucket } from '../src/dev-bucket';

/**
 * 真实地跑 deploy/cloud-backup.sh：开发 Postgres 的临时数据库、开发 S3 的单独前缀。
 * pg_dump 用和开发 Postgres 同版本的镜像，这样不依赖本机装了什么版本。
 */
const repo = resolve(import.meta.dirname, '../../..');
const script = resolve(repo, 'deploy/cloud-backup.sh');
const PASSPHRASE = 'fictional-test-passphrase-0123456789';
const MARKER = '虚构的宝宝记录';

function exampleEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(resolve(repo, 'apps/server/.env.example'), 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1]) env[match[1]] = match[2] ?? '';
  }
  return env;
}

let config: Config;
let admin: Sql;
let source: Sql;
let target: Sql;
let sourceUrl: string;
let targetUrl: string;
let s3: S3Client;
const suffix = `${process.pid}_${Date.now()}`;
const prefix = `backups-test-${suffix}/`;
const created: string[] = [];

function run(args: string[], extra: Record<string, string> = {}, input = '') {
  const e = exampleEnv();
  const running = promisify(execFile)('bash', [script, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BACKUP_PASSPHRASE: PASSPHRASE,
      BACKUP_PREFIX: prefix,
      // 设成空字符串可以测本机的 pg_dump 和 psql。
      BACKUP_PG_IMAGE: process.env.BACKUP_TEST_PG_IMAGE ?? 'postgres:16',
      BACKUP_DATABASE_URL: sourceUrl,
      RESTORE_DATABASE_URL: targetUrl,
      BACKUP_ASSUME_YES: '1',
      S3_ENDPOINT: e.S3_ENDPOINT ?? '',
      S3_REGION: e.S3_REGION ?? '',
      S3_BUCKET: e.S3_BUCKET ?? '',
      S3_ACCESS_KEY_ID: e.S3_ACCESS_KEY_ID ?? '',
      S3_SECRET_ACCESS_KEY: e.S3_SECRET_ACCESS_KEY ?? '',
      ...extra,
    },
  });
  running.child.stdin?.end(input);
  return running;
}

async function backup(): Promise<string> {
  const { stdout } = await run(['backup']);
  const key = /已备份：(\S+)（/.exec(stdout)?.[1];
  if (!key) throw new Error(`没有输出对象名：${stdout}`);
  created.push(key);
  return key;
}

const readObject = async (key: string) => {
  const object = await s3.send(
    new GetObjectCommand({ Bucket: config.serverStorage!.bucket, Key: key }),
  );
  return Buffer.from(await object.Body!.transformToByteArray());
};

const putBroken = async (name: string, body: Buffer) => {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const key = `${prefix}${name}`;
  await s3.send(
    new PutObjectCommand({ Bucket: config.serverStorage!.bucket, Key: key, Body: body }),
  );
  created.push(key);
  return key;
};

const familyName = async (sql: Sql) => {
  const rows = await sql<{ name: string }[]>`SELECT name FROM families`;
  return rows.map((r) => r.name);
};

beforeAll(async () => {
  config = loadConfig({
    ...exampleEnv(),
    DATABASE_URL: process.env.DATABASE_URL ?? exampleEnv().DATABASE_URL,
  });
  admin = connect(config.databaseUrl);
  const url = (name: string) => {
    const u = new URL(config.databaseUrl);
    u.pathname = `/${name}`;
    return u.toString();
  };
  await admin.unsafe(`CREATE DATABASE xiaodouya_backup_a_${suffix}`);
  await admin.unsafe(`CREATE DATABASE xiaodouya_backup_b_${suffix}`);
  sourceUrl = url(`xiaodouya_backup_a_${suffix}`);
  targetUrl = url(`xiaodouya_backup_b_${suffix}`);
  source = connect(sourceUrl);
  target = connect(targetUrl);
  await migrate(source);
  await source`INSERT INTO families (id, name, seq) VALUES (${randomUUID()}, ${MARKER}, 7)`;
  await ensureBucket(config);
  const s = config.serverStorage!;
  s3 = new S3Client({
    region: s.region,
    endpoint: s.endpoint,
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
  });
}, 120_000);

afterAll(async () => {
  for (const key of created) {
    await s3.send(new DeleteObjectCommand({ Bucket: config.serverStorage!.bucket, Key: key }));
  }
  await source.end();
  await target.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS xiaodouya_backup_a_${suffix} WITH (FORCE)`);
  await admin.unsafe(`DROP DATABASE IF EXISTS xiaodouya_backup_b_${suffix} WITH (FORCE)`);
  await admin.end();
});

describe('云端备份', () => {
  it('备份加密后上传，恢复到已有数据的库，内容和 RLS 都回来了', async () => {
    const key = await backup();
    expect(key.startsWith(prefix)).toBe(true);

    const stored = await readObject(key);
    expect(stored.subarray(0, 8).toString()).toBe('Salted__');
    expect(stored.includes(Buffer.from(MARKER))).toBe(false);
    expect(stored.includes(Buffer.from('PostgreSQL'))).toBe(false);

    await migrate(target);
    await target`INSERT INTO families (id, name) VALUES (${randomUUID()}, '恢复时应该被替换的数据')`;
    await run(['restore', 'latest']);

    expect(await familyName(target)).toEqual([MARKER]);
    const [family] = await target<{ seq: string }[]>`SELECT seq FROM families`;
    expect(Number(family?.seq)).toBe(7);
    const open = await target<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`;
    expect(open).toEqual([]);
    // 恢复之后服务端还能继续迁移和写入。
    await migrate(target);
    await target`INSERT INTO families (id, name) VALUES (${randomUUID()}, '恢复后的新数据')`;
  }, 120_000);

  it('口令不对时不动目标数据库', async () => {
    const key = await backup();
    const before = await familyName(target);
    await expect(
      run(['restore', key], { BACKUP_PASSPHRASE: 'another-fictional-passphrase-000' }),
    ).rejects.toThrow(/打不开或不完整/);
    expect(await familyName(target)).toEqual(before);
  }, 120_000);

  it('截断的备份不动目标数据库', async () => {
    const key = await backup();
    const stored = await readObject(key);
    const broken = await putBroken(
      'truncated.sql.gz.enc',
      stored.subarray(0, Math.floor(stored.length / 2)),
    );
    const before = await familyName(target);
    await expect(run(['restore', broken])).rejects.toThrow(/打不开或不完整/);
    expect(await familyName(target)).toEqual(before);
  }, 120_000);

  it('坏 SQL 会回滚，旧数据还在', async () => {
    const before = await familyName(target);
    const passphrase = { ...process.env, BACKUP_PASSPHRASE: PASSPHRASE };
    const script = `printf '%s\\n' 'CREATE SCHEMA public; SELECT no_such_function();' '-- PostgreSQL database dump complete' | gzip | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt -pass env:BACKUP_PASSPHRASE`;
    const { stdout } = await promisify(execFile)('bash', ['-c', script], {
      env: passphrase,
      encoding: 'buffer',
    });
    const broken = await putBroken('bad-sql.sql.gz.enc', stdout);
    await expect(run(['restore', broken])).rejects.toThrow();
    expect(await familyName(target)).toEqual(before);
  }, 120_000);

  it('在 Actions 里先遮盖主机名和用户名，输出里没有密码', async () => {
    const { stdout, stderr } = await run(['backup'], {
      GITHUB_ACTIONS: 'true',
      BACKUP_DATABASE_URL: sourceUrl,
    });
    const key = /已备份：(\S+)（/.exec(stdout)?.[1];
    if (key) created.push(key);
    expect(stdout).toContain('::add-mask::xiaodouya\n');
    expect(stdout).toContain('::add-mask::localhost\n');
    expect(`${stdout}${stderr}`).not.toContain('devpassword');
    expect(`${stdout}${stderr}`).not.toContain(PASSPHRASE);
  }, 120_000);

  it('口令太短时拒绝运行', async () => {
    await expect(run(['backup'], { BACKUP_PASSPHRASE: 'short' })).rejects.toThrow(/20 个字符/);
  });

  it('不确认就不恢复', async () => {
    const before = await familyName(target);
    const noPrompt = { BACKUP_ASSUME_YES: '' };
    await expect(run(['restore', 'latest'], noPrompt, 'no\n')).rejects.toThrow(/已取消/);
    await expect(run(['restore', 'latest'], noPrompt)).rejects.toThrow(/已取消/);
    expect(await familyName(target)).toEqual(before);
  }, 120_000);
});
