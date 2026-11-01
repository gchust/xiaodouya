// E2E 收尾：确认 App 上传的文件真的进了 S3，并且内容能下载回来。
// 不信任界面提示，直接查数据库和存储。

import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../apps/server/package.json'));
const postgres = require('postgres');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const runId = process.argv[2];
const sql = postgres(
  process.env.DATABASE_URL ?? 'postgres://xiaodouya:devpassword@localhost:55432/xiaodouya',
);
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:59000',
  forcePathStyle: true,
  credentials: { accessKeyId: 'devaccesskey', secretAccessKey: 'devsecretkey' },
});

const rows = await sql`
  SELECT m.id, m.variant, m.scope, m.mime, m.size, m.status, m.object_key
  FROM media m
  JOIN memberships ms ON ms.family_id = m.family_id
  JOIN users u ON u.id = ms.user_id
  WHERE u.email = ${`admin-${runId}@example.test`}`;

const failures = [];
const need = (ok, message) => {
  if (!ok) failures.push(message);
};
need(
  rows.some((r) => r.scope === 'memory' && r.variant === 'original'),
  '没有回忆原图',
);
need(
  rows.some((r) => r.scope === 'memory' && r.variant === 'thumb'),
  '没有回忆缩略图',
);
need(
  rows.some((r) => r.scope === 'document' && r.mime === 'application/pdf'),
  '没有证件 PDF',
);

for (const row of rows) {
  need(row.status === 'ready', `${row.object_key} 状态是 ${row.status}`);
  const object = await s3.send(
    new GetObjectCommand({ Bucket: 'xiaodouya-dev', Key: row.object_key }),
  );
  const bytes = await object.Body.transformToByteArray();
  need(bytes.length === Number(row.size), `${row.object_key} 大小不符`);
  if (row.mime === 'application/pdf') {
    need(Buffer.from(bytes.slice(0, 5)).toString() === '%PDF-', 'PDF 内容不对');
  }
  if (row.variant === 'thumb') {
    need(bytes[0] === 0xff && bytes[1] === 0xd8, `${row.object_key} 不是 JPEG 缩略图`);
  }
}
await sql.end();
console.log(`校验了 ${rows.length} 个对象`);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
