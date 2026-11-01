import { MAX_MEDIA_PER_RECORD } from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { MomentSheet } from '../sheets/MomentSheet';
import { useSheet } from '../ui/overlays';
import { recoverPendingPick } from './media';

/**
 * 选择器打开时 App 可能被系统回收。用户点“添加”后 App 冷启动，看起来就是闪退、选的照片全没了。
 * 启动时找回这次的选择，打开原来的弹层让用户接着保存。写到一半的文字找不回来，它们只在内存里。
 */
export function PendingPickRecovery() {
  const sheet = useSheet();
  const router = useRouter();
  const { open } = sheet;
  useEffect(() => {
    let alive = true;
    void recoverPendingPick()
      .then((files) => {
        if (!alive || files.length === 0) return;
        router.navigate('/recall');
        open('记下这一刻', () => (
          <MomentSheet initialFiles={files.slice(0, MAX_MEDIA_PER_RECORD)} />
        ));
      })
      .catch(() => {
        // 找不回来时和以前一样，用户再选一次。
      });
    return () => {
      alive = false;
    };
  }, [open, router]);
  return null;
}
