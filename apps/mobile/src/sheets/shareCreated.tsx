import { t } from '@xiaodouya/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../lib/app';
import { colors, fonts } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Mono, Muted } from '../ui/primitives';

/**
 * 时间线和选中回忆的链接创建好以后的样子：链接、还没传完的说明、发送、撤销（点两次）。
 * `title` 是“时间线 · …”、“回忆 · …”这样写明类型的一行。
 */
export function ShareCreated({
  id,
  url,
  title,
  pending,
  onSend,
}: {
  id: string;
  url: string;
  title: string;
  pending: { records: number; files: number };
  onSend: () => void;
}) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const revoke = async () => {
    if (!confirmingRevoke) {
      setConfirmingRevoke(true);
      return;
    }
    setBusy(true);
    try {
      await app.api.revokeShare(id);
      sheet.close();
      toast(t().share.revoked);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : t().share.revokeFailed);
      setBusy(false);
    }
  };

  return (
    <>
      <Text style={s.title} testID="share-created">
        {t().share.createdTitle}
      </Text>
      <Muted style={s.line}>{title}</Muted>
      <View style={s.linkBox}>
        <Mono style={s.link} testID="share-link" selectable numberOfLines={2}>
          {url}
        </Mono>
      </View>
      {pending.records > 0 || pending.files > 0 ? (
        <View style={s.warning} testID="share-pending">
          {pending.records > 0 ? (
            <Text style={s.warningText}>{t().share.pendingRecords(pending.records)}</Text>
          ) : null}
          {pending.files > 0 ? (
            <Text style={s.warningText}>{t().share.pendingFiles(pending.files)}</Text>
          ) : null}
        </View>
      ) : null}
      <Muted style={s.line}>{t().share.notice}</Muted>
      {problem ? <Text style={s.problem}>{problem}</Text> : null}
      {confirmingRevoke ? <Muted style={s.line}>{t().share.revokeNote}</Muted> : null}
      <Button testID="share-send" label={t().share.send} disabled={busy} onPress={onSend} />
      <Pressable
        testID="share-revoke-created"
        accessibilityRole="button"
        accessibilityLabel={t().share.revokeThis}
        disabled={busy}
        onPress={() => void revoke()}
        style={s.textButton}
      >
        <Text style={s.textButtonLabel}>
          {confirmingRevoke ? t().share.revoke : t().share.revokeThis}
        </Text>
      </Pressable>
    </>
  );
}

const s = StyleSheet.create({
  title: { fontFamily: fonts.serifBold, fontSize: 18, color: colors.ink },
  line: { fontSize: 13, lineHeight: 20 },
  problem: { fontSize: 13, lineHeight: 20, color: colors.danger },
  warning: { backgroundColor: colors.sand, borderRadius: 12, padding: 12, gap: 6 },
  warningText: { fontSize: 13, lineHeight: 20, color: colors.inkSoft },
  linkBox: { backgroundColor: colors.paper, borderRadius: 12, padding: 12 },
  link: { fontSize: 12, lineHeight: 18, color: colors.inkSoft },
  textButton: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 12 },
  textButtonLabel: { fontSize: 13, color: colors.danger },
});
