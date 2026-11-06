import {
  type CreateMomentsShareRequest,
  SHARE_TTL_DAYS,
  type ShareDisplay,
  type ShareTtlDays,
  t,
} from '@xiaodouya/shared';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ApiFailure } from '../lib/api';
import { useApp, useRecords } from '../lib/app';
import { SHARE_BASE_URL } from '../lib/config';
import { deviceTimezone } from '../lib/device';
import {
  nicknameProblem,
  shareLinkUrl,
  shareMomentsPending,
  shareMomentsRange,
  shareMomentsTitle,
} from '../lib/share';
import { colors, fonts } from '../theme';
import { Button, Chip, Muted } from '../ui/primitives';
import { ShareCreated, shareRightAway } from './shareCreated';
import { ShareDisplayRow, useSharePrefs } from './shareDisplay';

/** 同步最多等这么久。网不好时不能让人一直等：链接还是能建，缺什么会写清楚。 */
const SYNC_WAIT_MS = 8_000;

/**
 * 分享回忆（F-136）：一段或选中的几段。对方打开的是和时间线同一个页面，只有这几段，
 * 不含别的回忆、记录、信和出生时间。`onCreated` 在链接建好后调用（选择模式用它退出）。
 */
export function ShareMomentsSheet({
  ids,
  onCreated,
}: {
  ids: readonly string[];
  onCreated?: () => void;
}) {
  const app = useApp();
  const { moments } = useRecords();
  const prefs = useSharePrefs();
  const [ttlDays, setTtlDays] = useState<ShareTtlDays>(prefs.ttlDays);
  // 从账号的默认值开始，这里改的只用于这一次（F-141）。
  const [display, setDisplay] = useState<ShareDisplay>(prefs.display);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; url: string; title: string } | null>(null);
  const [pending, setPending] = useState({ records: 0, files: 0 });

  const chosen = moments.filter((m) => ids.includes(m.id));
  const title = shareMomentsTitle(ids, moments);
  const files = chosen.reduce((count, m) => count + m.data.media.length, 0);

  const messageFor = (url: string, linkTitle: string) =>
    t().share.momentsShareMessage(linkTitle, url);

  const create = async () => {
    // 选好以后家人可能在别的手机上删掉了全部，这时没有可以分享的。
    if (chosen.length === 0) return;
    setBusy(true);
    setProblem(null);
    // 先把这台手机上的回忆传上去，页面才看得到。失败不抛错，下面按实际情况说明还缺什么。
    await Promise.race([
      app.syncNow().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS)),
    ]);
    const body: CreateMomentsShareRequest = {
      momentIds: chosen.map((m) => m.id),
      ...shareMomentsRange(chosen),
      timezone: deviceTimezone() ?? app.prefs.timezone,
      ttlDays,
      display,
    };
    try {
      const share = await app.api.createMomentsShare(body);
      const url = shareLinkUrl(SHARE_BASE_URL ?? '', share.token, 'moments');
      const left = shareMomentsPending(
        app.store.getSnapshot(),
        body.momentIds,
        app.uploads.pendingIds(),
      );
      setPending(left);
      setCreated({ id: share.id, url, title });
      onCreated?.();
      shareRightAway(messageFor(url, title), left);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 0) setProblem(t().share.offline);
      else setProblem(error instanceof Error ? error.message : t().share.createFailed);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <ShareCreated
        id={created.id}
        url={created.url}
        title={t().share.linkTitleMoments(created.title)}
        message={messageFor(created.url, created.title)}
        pending={pending}
      />
    );
  }

  return (
    <>
      <Text style={s.title} testID="share-moments-title" numberOfLines={2}>
        {title}
      </Text>
      <Muted style={s.line} testID="share-moments-counts">
        {t().share.momentsCounts(chosen.length, files)}
      </Muted>
      <View style={s.warning} testID="share-moments-what">
        <Text style={s.warningText}>{t().share.momentsWhat}</Text>
        <Text style={s.warningText}>{t().share.timelineLocation}</Text>
      </View>
      <ShareDisplayRow value={display} onChange={setDisplay} />
      <View style={s.ttlRow}>
        <Muted style={s.ttlLabel}>{t().share.ttlTitle}</Muted>
        {SHARE_TTL_DAYS.map((days) => (
          <Chip
            key={days}
            testID={`share-ttl-${days}`}
            label={t().share.ttlDays(days)}
            selected={ttlDays === days}
            onPress={() => setTtlDays(days)}
          />
        ))}
      </View>
      <Text style={s.notice} testID="share-notice">
        {t().share.notice}
      </Text>
      {problem ? (
        <Text style={s.problem} testID="share-problem">
          {problem}
        </Text>
      ) : null}
      <Button
        testID="share-create"
        label={busy ? t().share.creating : t().share.create}
        disabled={busy || chosen.length === 0 || Boolean(nicknameProblem(display.nickname))}
        onPress={() => void create()}
      />
    </>
  );
}

const s = StyleSheet.create({
  title: { fontFamily: fonts.serifBold, fontSize: 18, color: colors.ink },
  line: { fontSize: 13, lineHeight: 20 },
  notice: { fontSize: 13, lineHeight: 20, color: colors.inkSoft },
  problem: { fontSize: 13, lineHeight: 20, color: colors.danger },
  warning: { backgroundColor: colors.sand, borderRadius: 12, padding: 12, gap: 6 },
  warningText: { fontSize: 13, lineHeight: 20, color: colors.inkSoft },
  ttlRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ttlLabel: { fontSize: 13, marginRight: 'auto' },
});
