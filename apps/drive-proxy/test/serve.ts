/**
 * 在本机跑代理：元数据用 SQLite，Drive 换成本机目录，其他前缀转发到开发用的 SeaweedFS。
 * 用来让服务端的集成测试整套经过代理：
 *
 *   pnpm --filter @xiaodouya/drive-proxy serve:local      # 另开一个终端
 *   TEST_S3_ENDPOINT=http://localhost:8790 pnpm test:server
 *
 * 代理收的密钥和 Bucket 名就用开发环境的，服务端那边只需要换地址。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { handle } from '../src/s3';
import { fixedLength, fsBlobs, sqliteDb } from './support';

const env = process.env;
const port = Number(env.PROXY_PORT ?? 8790);
const dir = env.PROXY_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'drive-proxy-local-'));
const credentials = {
  accessKeyId: env.S3_ACCESS_KEY_ID ?? 'devaccesskey',
  secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? 'devsecretkey',
};
const blobs = fsBlobs(join(dir, 'blobs'));
const db = sqliteDb(join(dir, 'meta.sqlite'));

serve(
  {
    port,
    fetch: (request) =>
      handle(request, {
        config: {
          bucket: env.S3_BUCKET ?? 'xiaodouya-dev',
          credentials,
          drivePrefix: 'families/',
          upstream: {
            endpoint: env.UPSTREAM_ENDPOINT ?? 'http://localhost:59000',
            bucket: env.S3_BUCKET ?? 'xiaodouya-dev',
            region: env.S3_REGION ?? 'us-east-1',
            credentials,
          },
          maxPutBytes: 5 * 1024 ** 3,
        },
        db,
        blobs,
        fetch,
        fixedLength,
        now: Date.now,
      }),
  },
  () => console.log(`drive-proxy on :${port}, data in ${dir}`),
);
