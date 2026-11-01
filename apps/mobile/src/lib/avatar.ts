import * as Crypto from 'expo-crypto';
import type { AppApi } from './app';
import { type PickedFile, queueForUpload } from './media';

/**
 * 把新头像放进上传队列并写回宝宝档案。
 * 每次都是新的文件 id：旧头像的文件留在存储里，还没同步到新版本的家人还要用它。
 */
export async function saveAvatar(
  app: Pick<AppApi, 'uploads' | 'store' | 'write'>,
  file: PickedFile,
): Promise<void> {
  const avatar = await queueForUpload(app.uploads, file, {
    id: Crypto.randomUUID(),
    scope: 'avatar',
    videoWifiOnly: false,
  });
  // 选图、编辑都可能花了一会儿，用最新的档案，不要盖掉家人刚改的内容。
  const latest = app.store.getSnapshot().baby;
  if (!latest) throw new Error('宝宝档案还没有同步好，请稍后再试');
  await app.write('baby', { ...latest.data, avatar }, latest.id);
}
