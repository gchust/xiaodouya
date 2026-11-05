import {
  type CreateTimelineShareRequest,
  countShareDay,
  DEFAULT_SHARE_TTL_DAYS,
  SHARE_TTL_DAYS,
  TIMELINE_SHARE_INCLUDE,
  t,
  timelineRangeText,
} from '@xiaodouya/shared';
import { useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { ApiFailure } from '../lib/api';
import { useApp, useRecords } from '../lib/app';
import { IS_E2E, SHARE_BASE_URL } from '../lib/config';
import { localDayBounds } from '../lib/dates';
import { deviceTimezone } from '../lib/device';
import {
  shareLinkUrl,
  shareTimelinePending,
  shareTimelineRange,
  type TimelinePreset,
} from '../lib/share';
import { colors, fonts } from '../theme';
import { PastDatePicker } from '../ui/BirthPicker';
import { Button, Chip, Muted } from '../ui/primitives';
import { ShareCreated } from './shareCreated';

/** 同步最多等这么久。网不好时不能让人一直等：链接还是能建，缺什么会写清楚。 */
const SYNC_WAIT_MS = 8_000;

const PRESETS: { key: TimelinePreset; label: () => string }[] = [
  { key: 'week', label: () => t().share.timelineRangeWeek },
  { key: 'month', label: () => t().share.timelineRangeMonth },
  { key: 'all', label: () => t().share.timelineRangeAll },
  { key: 'custom', label: () => t().share.timelineRangeCustom },
];

/** App 里按手机的时区显示：创建时发的就是这个时区。 */
const sameCalendar = (ms: number) => ms;

/**
 * 分享时间线（F-133）：选一段日期，对方打开网页能看到这段时间的全部回忆。
 * 只有回忆，不含喂奶、尿布这些记录和健康记录，弹层上写清楚对方能看到什么。
 */
export function ShareTimelineSheet() {
  const app = useApp();
  const { events, moments } = useRecords();
  const [preset, setPreset] = useState<TimelinePreset>('month');
  const [customFrom, setCustomFrom] = useState(
    () => new Date(localDayBounds(Date.now(), -6).start),
  );
  const [customTo, setCustomTo] = useState(() => new Date());
  const [ttlDays, setTtlDays] = useState<(typeof SHARE_TTL_DAYS)[number]>(DEFAULT_SHARE_TTL_DAYS);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; url: string; title: string } | null>(null);
  const [pending, setPending] = useState({ records: 0, files: 0 });

  const now = Date.now();
  const range = shareTimelineRange(preset, now, {
    from: customFrom.getTime(),
    to: customTo.getTime(),
  });
  const title = range ? timelineRangeText(range, now, sameCalendar) : '—';
  const counts = range
    ? countShareDay(events, moments, range, TIMELINE_SHARE_INCLUDE)
    : { records: 0, moments: 0, files: 0 };

  const send = (url: string, rangeTitle: string) => {
    void Share.share({ message: t().share.timelineShareMessage(rangeTitle, url) });
  };

  const create = async () => {
    if (!range) return;
    setBusy(true);
    setProblem(null);
    // 先把这台手机上的回忆传上去，页面才看得到。失败不抛错，下面按实际情况说明还缺什么。
    await Promise.race([
      app.syncNow().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, SYNC_WAIT_MS)),
    ]);
    const body: CreateTimelineShareRequest = {
      ...range,
      timezone: deviceTimezone() ?? app.prefs.timezone,
      ttlDays,
    };
    try {
      const share = await app.api.createTimelineShare(body);
      const url = shareLinkUrl(SHARE_BASE_URL ?? '', share.token, 'timeline');
      const left = shareTimelinePending(app.store.getSnapshot(), range, app.uploads.pendingIds());
      setPending(left);
      setCreated({ id: share.id, url, title });
      // 还有内容没传完时先让人看到说明，由 TA 决定现在发还是等等。
      // E2E 打不开系统分享面板，流程直接检查链接。
      if (left.records === 0 && left.files === 0 && !IS_E2E) send(url, title);
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
        title={t().share.linkTitleTimeline(created.title)}
        pending={pending}
        onSend={() => send(created.url, created.title)}
      />
    );
  }

  return (
    <>
      <Text style={s.title} testID="share-timeline-title">
        {title}
      </Text>
      <Muted style={s.line} testID="share-timeline-counts">
        {t().share.timelineCounts(counts.moments, counts.files)}
      </Muted>
      <View style={s.chips}>
        {PRESETS.map((item) => (
          <Chip
            key={item.key}
            testID={`share-range-${item.key}`}
            label={item.label()}
            selected={preset === item.key}
            onPress={() => setPreset(item.key)}
          />
        ))}
      </View>
      {preset === 'custom' ? (
        <View style={s.dates}>
          <View style={s.date}>
            <PastDatePicker
              testID="share-range-from"
              label={t().share.timelineFrom}
              value={customFrom}
              onChange={setCustomFrom}
            />
          </View>
          <View style={s.date}>
            <PastDatePicker
              testID="share-range-to"
              label={t().share.timelineTo}
              value={customTo}
              onChange={setCustomTo}
            />
          </View>
        </View>
      ) : null}
      {range ? null : (
        <Text style={s.problem} testID="share-range-bad">
          {t().share.timelineBadRange}
        </Text>
      )}
      <View style={s.warning} testID="share-timeline-what">
        <Text style={s.warningText}>{t().share.timelineWhat}</Text>
        <Text style={s.warningText}>{t().share.timelineLocation}</Text>
      </View>
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
        disabled={busy || !range}
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dates: { flexDirection: 'row', gap: 10 },
  date: { flex: 1 },
  warning: { backgroundColor: colors.sand, borderRadius: 12, padding: 12, gap: 6 },
  warningText: { fontSize: 13, lineHeight: 20, color: colors.inkSoft },
  ttlRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ttlLabel: { fontSize: 13, marginRight: 'auto' },
});
