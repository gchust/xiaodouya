import { t } from '@xiaodouya/shared';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { exportFileName } from './accountLogic';
import type { Api } from './api';

/**
 * 生成导出文件并打开系统分享。文件先留在缓存目录：有些 App 在分享面板关闭之后才读取，
 * 下次导出时覆盖，退出登录或删除账号时清除。
 */
export async function exportFamilyData(api: Api): Promise<void> {
  const data = await api.exportFamily();
  const file = new File(Paths.cache, exportFileName(new Date()));
  if (file.exists) file.delete();
  file.create();
  await file.write(JSON.stringify(data, null, 2));
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/json',
    UTI: 'public.json',
    dialogTitle: t().account.exportDialog,
  });
}
