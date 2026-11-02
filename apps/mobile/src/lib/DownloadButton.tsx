import type { MediaRef } from '@xiaodouya/shared';
import { t } from '@xiaodouya/shared';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Mono, Muted } from '../ui/primitives';
import { useApp } from './app';
import { downloadMessage, downloadProgressLabel } from './downloadCore';
import { cancelDownload, startDownload, useDownloadState } from './downloads';

/**
 * 文字按钮，点击后原地显示进度，下载中再点一次是取消。
 * sensitive 用于证件：先说明文件会离开 App 的保护范围，再让用户选位置，不会进相册。
 * 证件只在已解锁的证件详情页提供这个按钮，全屏查看器可以通过链接直接打开，不放这里。
 */
export function DownloadButton({
  media,
  fileName,
  sensitive = false,
  tone = 'card',
  testID,
}: {
  media: MediaRef;
  fileName: string;
  sensitive?: boolean;
  tone?: 'card' | 'dark';
  testID: string;
}) {
  const { api } = useApp();
  const { toast } = useFeedback();
  const sheet = useSheet();
  const state = useDownloadState(media.id);
  const ink = tone === 'dark' ? colors.white : colors.accent;

  const begin = () => {
    // 这里的 toast 属于根布局，页面关掉后结果也能提示。
    void startDownload(api, { media, fileName, sensitive }).then((outcome) => {
      const message = downloadMessage(outcome);
      if (message) toast(message);
    });
  };

  const onPress = () => {
    if (state) {
      cancelDownload(media.id);
      return;
    }
    if (!sensitive) {
      begin();
      return;
    }
    sheet.open(t().ui.saveToPhone, () => (
      <>
        <Muted style={{ fontSize: 13, lineHeight: 20 }} testID="doc-download-note">
          {t().ui.saveLeavesApp(fileName)}
        </Muted>
        <Button
          testID="doc-download-confirm"
          label={t().ui.chooseLocation}
          onPress={() => {
            sheet.close();
            begin();
          }}
        />
      </>
    ));
  };

  const progress = downloadProgressLabel(state);
  const saving = state?.phase === 'saving';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={
        state
          ? saving
            ? t().ui.savingFile(fileName)
            : t().ui.cancelDownload(fileName, progress ? t().ui.cancelDownloadDone(progress) : '')
          : t().ui.downloadFile(fileName)
      }
      accessibilityState={{ busy: Boolean(state), disabled: saving }}
      disabled={saving}
      hitSlop={12}
      onPress={onPress}
      style={s.button}
    >
      {progress ? (
        <Mono testID={`${testID}-progress`} weight="medium" style={[s.progress, { color: ink }]}>
          {progress}
        </Mono>
      ) : state ? (
        <ActivityIndicator size="small" color={ink} />
      ) : (
        <Text style={[s.label, { color: ink }]}>{t().ui.download}</Text>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  // 下载前后宽度不变，进度数字跳动时旁边的内容不会跟着动。
  button: { minWidth: 32, minHeight: 20, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 12 },
  progress: { fontSize: 12 },
});
