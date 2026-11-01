import { pathToFileURL } from 'node:url';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { type Config, loadConfig } from './config';

/** 只用于开发和测试：生产环境的 Bucket 由部署者提前创建。 */
export async function ensureBucket(config: Config): Promise<void> {
  const s = config.serverStorage;
  if (!s) return;
  const client = new S3Client({
    region: s.region,
    endpoint: s.endpoint,
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: s.bucket }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ensureBucket(loadConfig());
  console.log('Bucket 已就绪');
}
