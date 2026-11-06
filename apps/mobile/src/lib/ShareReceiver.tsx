import { parseSharedText, t } from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { ShareIntentNative } from '../../modules/share-intent';
import { openResourceSheet } from '../sheets/librarySheets';
import { useFeedback, useSheet } from '../ui/overlays';
import { useApp } from './app';

/**
 * 在别的 App 里点“分享”选了小豆芽（Android 的 ACTION_SEND 文字）：打开育儿资料页和添加弹层，
 * 链接和标题已经填好，点“存下”就行。只挂在登录好的页面下面，没登录时分享的内容等登录后再取。
 */
export function ShareReceiver() {
  const { role } = useApp();
  const router = useRouter();
  const sheet = useSheet();
  const { toast } = useFeedback();

  useEffect(() => {
    if (!ShareIntentNative) return;
    const native = ShareIntentNative;
    const take = () => {
      const shared = native.take();
      if (!shared) return;
      if (role === 'viewer') {
        toast(t().library.shareViewer);
        return;
      }
      const parsed = parseSharedText(shared.text, shared.subject);
      if (!parsed) {
        toast(t().library.shareNoLink);
        return;
      }
      router.navigate('/resources');
      openResourceSheet(sheet, { initial: parsed });
    };
    take();
    const onShare = native.addListener('onShare', take);
    const onActive = AppState.addEventListener('change', (state) => {
      if (state === 'active') take();
    });
    return () => {
      onShare.remove();
      onActive.remove();
    };
  }, [role, router, sheet, toast]);

  return null;
}
