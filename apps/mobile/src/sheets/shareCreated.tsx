import { t } from '@xiaodouya/shared';
import { Image } from 'expo-image';
import { type ReactNode, useState } from 'react';
import { Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { ShareTargetsNative } from '../../modules/share-targets';
import { useApp, useRegion } from '../lib/app';
import { IS_E2E } from '../lib/config';
import {
  canSendDirectly,
  copyText,
  type ShareTargetButton,
  sendTextTo,
  useShareTargets,
} from '../lib/shareTargets';
import { colors, fonts } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Mono, Muted, PressScale } from '../ui/primitives';

/**
 * 系统分享面板：iOS 一直用它，Android 上是“更多”。Android 上用自己的模块打开，去掉小豆芽自己：
 * App 也收文字分享（存成育儿资料，F-143），React Native 的 Share 不能排除。
 */
export const openSystemShare = (message: string) => {
  if (Platform.OS === 'android' && ShareTargetsNative) {
    void ShareTargetsNative.shareSheet(message)
      .catch(() => false)
      .then((opened) => {
        if (!opened) void Share.share({ message });
      });
    return;
  }
  void Share.share({ message });
};

/**
 * 链接建好、内容都传完时，iOS 直接打开系统分享面板，省一步。Android 不自动打开：
 * 要让人先看到常用 App 那一排，否则又是一整屏的 App（issue #94）。
 * 还有没传完的内容时先让人看到说明，由 TA 决定现在发还是等等。E2E 打不开系统分享面板。
 */
export const shareRightAway = (message: string, pending: { records: number; files: number }) => {
  if (Platform.OS === 'ios' && pending.records === 0 && pending.files === 0 && !IS_E2E) {
    openSystemShare(message);
  }
};

/**
 * 三种分享（一天、时间线、选中的回忆）的链接创建好以后的样子：链接、还没传完的说明、发送、撤销（点两次）。
 * `title` 是“时间线 · …”、“回忆 · …”这样写明类型的一行，`message` 是发出去的整段文字。
 *
 * Android 上直接列出这台手机装了的常用聊天 App（按地区排，F-139），点了把文字发过去；最后是“更多”（系统分享面板），
 * 下面是复制链接。一个都没装时和 iOS 一样只有“发送给别人”。
 */
export function ShareCreated({
  id,
  url,
  title,
  message,
  pending,
}: {
  id: string;
  url: string;
  title: string;
  message: string;
  pending: { records: number; files: number };
}) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const region = useRegion();
  const targets = useShareTargets(region.shareTargets);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  // 复制过就一直写“已复制”，不定时变回去：Android 13 起系统自己也会在左下角提示一下，
  // 按钮上的字只是让人确认刚才那一下生效了，再点还是会复制。
  const [copied, setCopied] = useState(false);

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

  const sendTo = async (target: ShareTargetButton) => {
    setProblem(null);
    if (!(await sendTextTo(target.packageName, message))) setProblem(t().share.sendFailed);
  };

  const copy = async () => {
    // 复制的只是链接，粘贴到哪里都能用；发送时带的说明文字不复制。
    if (await copyText(url)) setCopied(true);
  };

  const direct = canSendDirectly();

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
      {problem ? (
        <Text style={s.problem} testID="share-problem">
          {problem}
        </Text>
      ) : null}
      {confirmingRevoke ? <Muted style={s.line}>{t().share.revokeNote}</Muted> : null}
      {direct && targets === null ? (
        // 查装了什么只要几十毫秒，先占住位置，按钮出来时下面的内容不跳。
        <View style={s.targetsPlaceholder} />
      ) : direct && targets && targets.length > 0 ? (
        <View style={s.targetsBlock} testID="share-targets">
          <Muted style={s.targetsLabel}>{t().share.sendToTitle}</Muted>
          <View style={s.targets}>
            {targets.map((target) => (
              <TargetTile
                key={target.packageName}
                testID={`share-target-${target.id}`}
                label={target.label}
                a11y={t().share.sendTo(target.label)}
                disabled={busy}
                onPress={() => void sendTo(target)}
              >
                {target.icon ? (
                  <Image source={{ uri: target.icon }} style={s.icon} contentFit="contain" />
                ) : (
                  <View style={[s.icon, s.iconFallback]}>
                    <Text style={s.iconLetter}>{Array.from(target.label)[0] ?? '?'}</Text>
                  </View>
                )}
              </TargetTile>
            ))}
            <TargetTile
              testID="share-more"
              label={t().share.more}
              a11y={t().share.moreA11y}
              disabled={busy}
              onPress={() => openSystemShare(message)}
            >
              <View style={[s.icon, s.iconMore]}>
                <Text style={s.moreDots}>···</Text>
              </View>
            </TargetTile>
          </View>
        </View>
      ) : (
        <Button
          testID="share-send"
          label={t().share.send}
          disabled={busy}
          onPress={() => openSystemShare(message)}
        />
      )}
      {direct ? (
        <Button
          testID="share-copy"
          tone="outline"
          height={46}
          label={copied ? t().share.copied : t().share.copy}
          disabled={busy}
          onPress={() => void copy()}
        />
      ) : null}
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

function TargetTile({
  testID,
  label,
  a11y,
  disabled,
  onPress,
  children,
}: {
  testID: string;
  label: string;
  a11y: string;
  disabled: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <PressScale
      testID={testID}
      accessibilityLabel={a11y}
      disabled={disabled}
      onPress={onPress}
      style={s.tile}
    >
      {children}
      <Text style={s.tileLabel} numberOfLines={1}>
        {label}
      </Text>
    </PressScale>
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
  targetsPlaceholder: { height: 92 },
  targetsBlock: { gap: 8 },
  targetsLabel: { fontSize: 12 },
  // 最多 4 个加“更多”，5 格平分一行，小屏（360 宽减去弹层边距）每格也有 60。
  targets: { flexDirection: 'row' },
  tile: { flex: 1, maxWidth: '20%', alignItems: 'center', gap: 6, paddingVertical: 4 },
  icon: { width: 44, height: 44, borderRadius: 12 },
  iconFallback: { backgroundColor: colors.sand, alignItems: 'center', justifyContent: 'center' },
  iconLetter: { fontFamily: fonts.serifBold, fontSize: 18, color: colors.inkSoft },
  iconMore: {
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreDots: { fontSize: 18, lineHeight: 20, color: colors.inkSoft, letterSpacing: 1 },
  tileLabel: { fontSize: 11, color: colors.inkSoft, maxWidth: 64 },
  textButton: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 12 },
  textButtonLabel: { fontSize: 13, color: colors.danger },
});
