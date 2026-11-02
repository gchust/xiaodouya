// E2E 收尾：确认 App 上传的文件真的进了 S3，并且内容能下载回来。
// 不信任界面提示，直接查数据库和存储。

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { FICTIONAL_DESCRIPTION, jpegMetadata } from './helpers/jpeg-exif.mjs';

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

/** 从 JPEG 文件头读出实际的宽高：记录里写的尺寸不能证明图片真的被旋转或裁剪过。 */
function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    const marker = bytes[i + 1];
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
      };
    }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}
need(
  rows.some((r) => r.scope === 'memory' && r.variant === 'original'),
  '没有回忆原图',
);
need(
  rows.some((r) => r.scope === 'memory' && r.variant === 'thumb'),
  '没有回忆缩略图',
);
// 流程 03a、03b 的样例里有超过分片阈值（16 MB）的图。服务端的完成接口核对过每一片，这里再下载核对大小。
need(
  rows.some((r) => r.scope === 'memory' && Number(r.size) > 16 * 1024 * 1024),
  '没有超过分片阈值的文件，分片上传没有被走到',
);
need(
  rows.some((r) => r.scope === 'memory' && r.variant === 'preview'),
  '没有回忆预览',
);
// 证件和头像不做预览，视频也不做。
for (const row of rows.filter((r) => r.variant === 'preview')) {
  need(row.scope === 'memory', `${row.object_key} 不该有预览`);
  need(row.mime === 'image/jpeg', `${row.object_key} 预览不是 JPEG`);
  const original = rows.find((r) => r.id === row.id && r.variant === 'original');
  need(original?.mime.startsWith('image/'), `${row.object_key} 不是照片的预览`);
}
need(
  rows.some((r) => r.scope === 'document' && r.mime === 'application/pdf'),
  '没有证件 PDF',
);

need(
  rows.some((r) => r.scope === 'avatar' && r.variant === 'original'),
  '没有头像原图',
);
need(
  rows.some((r) => r.scope === 'avatar' && r.variant === 'thumb'),
  '没有头像缩略图',
);
const [babyRow] = await sql`
  SELECT r.data FROM records r
  JOIN memberships ms ON ms.family_id = r.family_id
  JOIN users u ON u.id = ms.user_id
  WHERE u.email = ${`admin-${runId}@example.test`} AND r.collection = 'baby' AND r.deleted = false`;
const avatar = babyRow?.data?.avatar;
need(avatar?.mime === 'image/jpeg', '当前头像不是编辑后的 JPEG');
const avatarSizes = new Map();
const metadata = new Map();

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
  if (row.mime === 'image/jpeg') {
    metadata.set(`${row.id}/${row.variant}`, {
      ...jpegMetadata(bytes),
      fictional: Buffer.from(bytes).includes(FICTIONAL_DESCRIPTION),
    });
  }
  // 分享页发给陌生人的就是这两个变体。不只查 GPS：任何 APP 段都可能带着元数据。
  if (row.variant === 'thumb' || row.variant === 'preview') {
    const found = jpegMetadata(bytes);
    need(found.isJpeg, `${row.object_key} 不是 JPEG`);
    need(!found.exif && !found.gps && !found.xmp, `${row.object_key} 带着元数据`);
    need(found.appSegments === 0, `${row.object_key} 还有 ${found.appSegments} 个 APP 段`);
  }
  if (row.scope === 'avatar' && row.variant === 'original' && row.mime === 'image/jpeg') {
    avatarSizes.set(row.id, jpegSize(bytes));
  }
}
await sql.end();

// 流程 14a：320×160 旋转后是 160×320，再裁成 160×160。
const edited = [...avatarSizes.values()];
need(
  edited.some((size) => size?.width === 160 && size?.height === 320),
  `没有旋转后的头像：${JSON.stringify(edited)}`,
);
const current = avatarSizes.get(avatar?.id);
need(
  current?.width === 160 && current?.height === 160,
  `当前头像不是裁好的正方形：${JSON.stringify(current)}`,
);
need(avatar?.width === 160 && avatar?.height === 160, '记录里的头像尺寸不对');
// 流程 03a 的样例：原图带 GPS，所以上面“预览和缩略图没有元数据”才算数，查的方法也是灵的。
const gpsOriginals = rows.filter(
  (r) => r.variant === 'original' && metadata.get(`${r.id}/original`)?.gps,
);
need(gpsOriginals.length > 0, '没有带 GPS 的原图，预览里没有 EXIF 这件事没有被验证到');
for (const { id } of gpsOriginals) {
  const original = metadata.get(`${id}/original`);
  need(original.orientation === 6 && original.fictional, '原图被改过：应该原样保存');
  const preview = metadata.get(`${id}/preview`);
  need(preview, `带 GPS 的照片 ${id} 没有预览`);
  need(preview && !preview.fictional, `预览 ${id} 带着原图的 EXIF 内容`);
  // 64×48 加 Orientation=6：EXIF 去掉之后，方向只能靠像素本身。也不能放大。
  need(
    preview?.width === 48 && preview?.height === 64,
    `预览 ${id} 的尺寸不对：${preview?.width}×${preview?.height}`,
  );
  const thumb = metadata.get(`${id}/thumb`);
  need(thumb && !thumb.fictional, `缩略图 ${id} 带着原图的 EXIF 内容`);
  need(thumb && thumb.height > thumb.width, `缩略图 ${id} 方向不对`);
}
console.log(`校验了 ${rows.length} 个对象`);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
