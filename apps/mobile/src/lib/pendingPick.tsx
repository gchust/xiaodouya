import { MAX_MEDIA_PER_RECORD } from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { MomentSheet } from '../sheets/MomentSheet';
import { useFeedback, useSheet } from '../ui/overlays';
import { recoverPendingPick } from './media';

/**
 * 选择器打开时 App 可能被系统回收。用户点“添加”后 App 冷启动，看起来就是闪退、选的照片全没了。
 * 启动时能找回就打开原来的弹层接着保存，找不回也要说一声，不能什么都不提示。
 */
export function PendingPickRecovery() {
  const { open } = useSheet();
  const { toast } = useFeedback();
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    void recoverPendingPick()
      .then(({ files, interrupted }) => {
        if (!alive) return;
        if (files.length > 0) {
          router.navigate('/recall');
          open('记下这一刻', () => (
            <MomentSheet initialFiles={files.slice(0, MAX_MEDIA_PER_RECORD)} />
          ));
        } else if (interrupted) {
          router.navigate('/recall');
          toast('刚才系统把小豆芽关掉了，选的照片没带回来，再选一次就好。', { durationMs: 8000 });
        }
      })
      .catch(() => {
        // 这里出错不影响正常使用。
      });
    return () => {
      alive = false;
    };
  }, [open, router, toast]);
  return null;
}
