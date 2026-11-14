import {
  type CreateShareRequest,
  countShareDay,
  defaultShareInclude,
  formatShortDate,
  isDefaultShareDisplay,
  SHARE_TTL_DAYS,
  type ShareDisplay,
  type ShareInclude,
  type ShareSummary,
  type ShareTtlDays,
  t,
} from '@xiaodouya/shared';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { ApiFailure } from '../lib/api';
import { useApp, useRecords, useUnits } from '../lib/app';
import { DEFAULT_API_URL, SHARE_BASE_URL } from '../lib/config';
import { deviceTimezone } from '../lib/device';
import {
  canShare,
  nicknameProblem,
  shareBabyField,
  shareBabyName,
  shareDayPending,
  shareDayRange,
  shareDayTitle,
  shareDisplaySummary,
  shareLinkTitle,
  shareLinkUrl,
} from '../lib/share';
import { colors, fonts, themedStyles } from '../theme';
import { Button, Chip, Muted, Toggle } from '../ui/primitives';
import { ShareCreated, shareRightAway } from './shareCreated';
import { ShareDisplayRow, useSharePrefs } from './shareDisplay';

/** 同步最多等这么久。网不好时不能让人一直等：链接还是能建，缺什么会写清楚。 */
const SYNC_WAIT_MS = 8_000;

export function useCanShare(): boolean {
  const { role, serverUrl } = useApp();
  return canShare({
    baseUrl: SHARE_BASE_URL,
    serverUrl,
    defaultServerUrl: DEFAULT_API_URL,
    role,
  });
}

export function ShareDaySheet({ at }: { at: number }) {
  const app = useApp();
  const { events, moments } = useRecords();
  const units = useUnits();
  const prefs = useSharePrefs();
  const [include, setInclude] = useState<ShareInclude>(defaultShareInclude);
  const [ttlDays, setTtlDays] = useState<ShareTtlDays>(prefs.ttlDays);
  // 从账号的默认值开始，这里改的只用于这一次（F-141）。
  const [display, setDisplay] = useState<ShareDisplay>(prefs.display);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null);
  const [pending, setPending] = useState({ records: 0, files: 0 });

  const range = shareDayRange(at);
  const title = shareDayTitle(range.fromAt, Date.now());
  const counts = countShareDay(events, moments, range, include);
  const nothingSelected = !include.moments && !include.daily && !include.health;

  const messageFor = (url: string) => t().share.shareMessage(title, url);

  const create = async () => {
    setBusy(true);
    setProblem(null);
    // 先把这台手机上的记录传上去，页面才看得到。失败不抛错，下面按实际情况说明还缺什么。
    await Promise.race([
      app.syncNow().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS)),
    ]);
    const body: CreateShareRequest = {
      ...range,
      timezone: deviceTimezone() ?? app.prefs.timezone,
      include,
      units,
      ttlDays,
      display,
      ...shareBabyField(app.store.getSnapshot()),
    };
    try {
      const share = await app.api.createShare(body);
      const url = shareLinkUrl(SHARE_BASE_URL ?? '', share.token);
      const left = shareDayPending(
        app.store.getSnapshot(),
        range,
        include,
        app.uploads.pendingIds(),
      );
      setPending(left);
      setCreated({ id: share.id, url });
      shareRightAway(messageFor(url), left);
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
        title={t().share.linkTitleDay(title)}
        message={messageFor(created.url)}
        pending={pending}
      />
    );
  }

  return (
    <>
      <Text style={s.title} testID="share-day-title">
        {title}
      </Text>
      <Muted style={s.line} testID="share-counts">
        {t().share.counts(counts.records, counts.moments, counts.files)}
      </Muted>
      <View>
        <Toggle
          testID="share-include-moments"
          label={t().share.includeMoments}
          value={include.moments}
          onChange={(moments) => setInclude({ ...include, moments })}
        />
        <Toggle
          testID="share-include-daily"
          label={t().share.includeDaily}
          sub={t().share.includeDailySub}
          value={include.daily}
          onChange={(daily) => setInclude({ ...include, daily })}
        />
        <Toggle
          testID="share-include-health"
          label={t().share.includeHealth}
          sub={t().share.includeHealthSub}
          value={include.health}
          onChange={(health) => setInclude({ ...include, health })}
          last
        />
      </View>
      {include.health ? (
        <View style={s.warning} testID="share-health-warning">
          <Text style={s.warningText}>{t().share.includeHealthOn}</Text>
        </View>
      ) : null}
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
      {nothingSelected ? <Muted style={s.line}>{t().share.nothingSelected}</Muted> : null}
      <Button
        testID="share-create"
        label={busy ? t().share.creating : t().share.create}
        disabled={busy || nothingSelected || Boolean(nicknameProblem(display.nickname))}
        onPress={() => void create()}
      />
    </>
  );
}

export function SharedLinksSheet() {
  const app = useApp();
  const snapshot = useRecords();
  // 链接可能是别的宝宝的：标题要用全部宝宝的回忆找名字（issue #106）。
  const moments = snapshot.all.moments;
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    app.api
      .listShares()
      .then((result) => {
        if (live) setShares(result.shares);
      })
      .catch(() => {
        if (live) setProblem(t().share.linksFailed);
      });
    return () => {
      live = false;
    };
  }, [app.api]);

  const revoke = async (id: string) => {
    if (confirming !== id) {
      setConfirming(id);
      return;
    }
    try {
      await app.api.revokeShare(id);
      setConfirming(null);
      setShares((current) => current?.filter((share) => share.id !== id) ?? null);
    } catch {
      setProblem(t().share.revokeFailed);
    }
  };

  if (problem && !shares) {
    return <Muted style={s.line}>{problem}</Muted>;
  }
  if (!shares) return <Muted style={s.line}>{t().family.loading}</Muted>;
  if (shares.length === 0) {
    return (
      <Muted style={s.line} testID="shares-empty">
        {t().share.linksEmpty}
      </Muted>
    );
  }
  return (
    <View testID="shares-list">
      {problem ? <Text style={s.problem}>{problem}</Text> : null}
      {shares.map((share, index) => (
        <View
          key={share.id}
          style={[s.shareRow, index === shares.length - 1 ? null : s.shareRowLine]}
          testID={`share-row-${index}`}
        >
          <View style={s.shareRowTop}>
            <View style={{ flex: 1 }}>
              <Text style={s.shareDate}>{shareLinkTitle(share, Date.now(), moments)}</Text>
              <Muted style={s.shareSub}>
                {t().share.linkLine(formatShortDate(share.expiresAt), share.byLabel)}
              </Muted>
              {shareBabyName(share, snapshot) ? (
                <Muted style={s.shareSub} testID={`share-row-baby-${index}`}>
                  {t().babies.shareFor(shareBabyName(share, snapshot) ?? '')}
                </Muted>
              ) : null}
              {share.display && !isDefaultShareDisplay(share.display) ? (
                <Muted style={s.shareSub} testID={`share-row-display-${index}`}>
                  {shareDisplaySummary(share.display)}
                </Muted>
              ) : null}
            </View>
            {share.canRevoke ? (
              <Chip
                testID={`share-revoke-${index}`}
                label={t().share.revoke}
                selected={confirming === share.id}
                onPress={() => void revoke(share.id)}
              />
            ) : null}
          </View>
          {confirming === share.id ? (
            <Muted style={s.shareSub}>{t().share.revokeNote}</Muted>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const s = themedStyles(() => ({
  title: { fontFamily: fonts.serifBold, fontSize: 18, color: colors.ink },
  line: { fontSize: 13, lineHeight: 20 },
  notice: { fontSize: 13, lineHeight: 20, color: colors.inkSoft },
  problem: { fontSize: 13, lineHeight: 20, color: colors.dangerText },
  warning: { backgroundColor: colors.sand, borderRadius: 12, padding: 12, gap: 6 },
  warningText: { fontSize: 13, lineHeight: 20, color: colors.inkSoft },
  ttlRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ttlLabel: { fontSize: 13, marginRight: 'auto' },
  shareRow: { paddingVertical: 12, gap: 6 },
  shareRowLine: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  shareRowTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  shareDate: { fontSize: 14, color: colors.ink },
  shareSub: { fontSize: 12, lineHeight: 18 },
}));
