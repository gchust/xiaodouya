import {
  activeSleep,
  ageParts,
  ageText,
  assessDayNutrition,
  type BreastSide,
  breastFeedState,
  breastSeconds,
  createTapGuard,
  dayNumber,
  describeEvent,
  dueVaccine,
  type EventData,
  estimateNextFeed,
  formatClock,
  formatDateHeader,
  formatDuration,
  formatHoursMinutes,
  formatMediaDuration,
  formatVolume,
  guardTap,
  nextBreastSide,
  nutritionEntryText,
  planSchedule,
  summarize24h,
  summaryText,
  TAP_HOLD_MS,
  t,
  timelineEntries,
  todayInsight,
  type Units,
  vaccineReminderText,
  vaccineStatuses,
} from '@xiaodouya/shared';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useNow, useRecords, useRegion, useUnits } from '../lib/app';
import { saveAvatar } from '../lib/avatar';
import { localDayBounds } from '../lib/dates';
import { pickFromLibrary } from '../lib/media';
import { MediaImage } from '../lib/mediaViews';
import { useTabScrollRef } from '../lib/tabScroll';
import {
  DiaperSheet,
  EventActionsSheet,
  FeedSheet,
  MoreSheet,
  VaccineSheet,
} from '../sheets/recordSheets';
import { ShareDaySheet, useCanShare } from '../sheets/shareSheets';
import { colors, fonts, spacing, themedStyles } from '../theme';
import { NotificationPrompt } from '../ui/NotificationPrompt';
import { useFeedback, useSheet } from '../ui/overlays';
import { Card, Dot, Mono, Muted, PressScale, Stripes } from '../ui/primitives';
import { Highlighted } from '../ui/Search';
import { SyncingPlaceholder } from '../ui/SyncingPlaceholder';
import { UpdateReadyCard } from '../ui/UpdateReadyCard';
import { useWidgetLink } from '../widgets/useWidgetLink';

/** 链接文字只有 16 高，上下各扩 14 才到 44。 */
const LINK_HIT_SLOP = { top: 14, bottom: 14, left: 12, right: 12 };

export function TodayScreen() {
  const insets = useSafeAreaInsets();
  const scrollRef = useTabScrollRef('today');
  const app = useApp();
  const router = useRouter();
  const { events, baby, pendingCount, vaccinePlans } = useRecords();
  const region = useRegion();
  const units = useUnits();
  const sheet = useSheet();
  const showShare = useCanShare();
  const { toast } = useFeedback();
  // 只用来定时刷新。过滤记录要用渲染时的时间：否则刚保存的记录比 now 新，最多 15 秒不显示，家长可能重复记录。
  useNow(15_000);
  const now = Date.now();
  const [refreshing, setRefreshing] = useState(false);
  const [changingAvatar, setChangingAvatar] = useState(false);
  // 睡眠按钮是开关，连点两下会记成“睡着又马上醒了”（issue #69），见 `tapGuard.ts`。
  const sleepTaps = useRef(createTapGuard({ holdMs: TAP_HOLD_MS })).current;
  useWidgetLink({
    ready: Boolean(baby) && app.role !== 'viewer',
    openEvent: (id) => {
      const entry = events.find((e) => e.id === id);
      if (!entry) return;
      sheet.open(describeEvent(entry.data, Date.now(), units), () => (
        <EventActionsSheet id={entry.id} event={entry.data} />
      ));
    },
    openFeed: () => sheet.open(t().today.feed, () => <FeedSheet />),
  });

  if (!baby) return <SyncingPlaceholder />;
  const birthAt = baby.data.birthAt;
  const data = events.map((e) => e.data);
  const estimate = estimateNextFeed(data, now);
  const breast = breastFeedState(data, now);
  const lastFeed = estimate.last;
  const lastIsBreast = lastFeed?.method === 'breast';
  // 上次是亲喂才提示下次从哪侧开始；瓶喂的家庭看不到这一行。
  const nextSide = lastIsBreast ? nextBreastSide(data, now) : null;
  const sleeping = activeSleep(data);
  const summary = summarize24h(data, now);
  const insight = todayInsight(data, birthAt, now);
  const recent = timelineEntries(events, now);
  const vaccine = dueVaccine(
    vaccineStatuses(planSchedule(region, birthAt, vaccinePlans, data), birthAt, data, now),
  );
  const today = localDayBounds(now);
  const nutritionText = nutritionEntryText(
    assessDayNutrition({
      events: data,
      dayStart: today.start,
      dayEnd: today.end,
      now,
      ageMonths: ageParts(birthAt, now).months,
      reference: region.nutrition,
    }),
  );

  const feedHint = !estimate.last
    ? ''
    : !estimate.isLearned
      ? t().today.estimateLater
      : estimate.remainingMs > 0
        ? t().today.nextFeedIn(formatDuration(estimate.remainingMs))
        : t().today.feedDue;
  const feedHintNear = estimate.isLearned && estimate.remainingMs < 30 * 60_000;

  /** `shownAsleep` 是被点的按钮画出来时的状态，也就是用户以为自己在点的那个。 */
  const toggleSleep = (shownAsleep: boolean) =>
    guardTap(sleepTaps, 'sleep', Date.now, async () => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      const latest = app.store.getSnapshot().events;
      const open = activeSleep(latest.map((e) => e.data));
      const openEntry = open ? latest.find((e) => e.data === open) : undefined;
      // 上一下已经写好、按钮还没来得及重画时又点了一下：按“睡眠”是要开始，已经开始了就什么都不做，
      // 不能把刚开始的睡眠结束掉。手机忙的时候第二下可能晚于 500 ms 才到，只靠时间挡不住。
      if (Boolean(open) !== shownAsleep) return;
      if (open && openEntry) {
        const end = Date.now();
        await app.write('event', { ...open, endAt: end }, openEntry.id);
        toast(t().today.wokeUp(formatDuration(end - open.at)));
      } else {
        const id = await app.write('event', { type: 'sleep', at: Date.now(), byName: app.label });
        toast(t().today.sleepStarted, { undo: () => void app.remove(id) });
      }
    });

  const changeAvatar = async () => {
    setChangingAvatar(true);
    try {
      const [file] = await pickFromLibrary({ singleImage: true });
      if (!file) return;
      await saveAvatar(app, file);
      toast(t().ui.avatarDone);
    } catch (error) {
      toast(error instanceof Error ? error.message : t().today.avatarFailed);
    } finally {
      setChangingAvatar(false);
    }
  };

  const openFeed = () => sheet.open(t().today.feed, () => <FeedSheet />);
  const avatar = baby.data.avatar;
  const canChangeAvatar = app.role !== 'viewer';
  const syncLine =
    app.syncStatus === 'offline'
      ? pendingCount > 0
        ? t().today.offlinePending(pendingCount)
        : t().today.offline
      : pendingCount > 0
        ? t().today.syncing(pendingCount)
        : null;

  return (
    <ScrollView
      ref={scrollRef}
      testID="today-screen"
      style={s.scroll}
      contentContainerStyle={{ paddingTop: insets.top + 18, paddingBottom: 24 }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.accent}
          colors={[colors.accent]}
          onRefresh={() => {
            setRefreshing(true);
            void app.syncNow().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <View style={s.header}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.date}>{formatDateHeader(now)}</Text>
          <Text accessibilityRole="header" style={s.title} testID="today-title" numberOfLines={2}>
            {t().today.title(baby.data.name, dayNumber(birthAt, now))}
          </Text>
          <Muted>{ageText(birthAt, now)}</Muted>
          {syncLine ? (
            <Muted testID="sync-status" style={{ color: colors.accentText, fontSize: 11 }}>
              {syncLine}
            </Muted>
          ) : null}
        </View>
        <PressScale
          testID="baby-avatar"
          accessibilityLabel={avatar ? t().today.viewAvatar : t().today.addAvatar}
          accessibilityState={{ busy: changingAvatar, disabled: !avatar && !canChangeAvatar }}
          disabled={changingAvatar || (!avatar && !canChangeAvatar)}
          style={s.avatar}
          onPress={() => {
            // 还没有头像时没什么可放大的，直接选图。
            if (avatar) router.push({ pathname: '/viewer', params: { avatar: '1' } });
            else void changeAvatar();
          }}
        >
          {avatar ? (
            <MediaImage media={avatar} variant="thumb" style={StyleSheet.absoluteFill} />
          ) : (
            <Stripes style={StyleSheet.absoluteFill} />
          )}
          {changingAvatar ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        </PressScale>
      </View>

      <PressScale
        testID="feed-card"
        accessibilityLabel={
          breast.status === 'running' && breast.feed.side
            ? t().today.breastRunningA11y(
                sideName(breast.feed.side),
                formatMediaDuration(breastSeconds(breast.feed, now)[breast.feed.side] * 1000),
              )
            : breast.status === 'forgotten'
              ? t().today.breastForgotten
              : t().today.sinceLastFeedA11y
        }
        scaleTo={0.98}
        onPress={openFeed}
        style={s.feedCard}
      >
        {breast.status !== 'none' ? (
          <BreastCard feed={breast.feed} forgotten={breast.status === 'forgotten'} />
        ) : (
          <>
            <View style={s.feedTop}>
              <Text style={s.feedLabel}>{t().today.sinceLastFeed}</Text>
              <Text
                style={[s.feedHint, { color: feedHintNear ? colors.accentText : colors.muted }]}
              >
                {feedHint}
              </Text>
            </View>
            <Mono weight="medium" style={s.timer} testID="feed-timer">
              {estimate.last ? formatHoursMinutes(estimate.sinceMs) : '—'}
            </Mono>
            <Muted testID="last-feed">
              {!lastFeed
                ? t().today.noFeedYet
                : lastIsBreast
                  ? t().today.lastFeedText(
                      formatClock(lastFeed.at),
                      describeEvent(lastFeed, now, units),
                      lastFeed.byName ? t().today.lastFeedBy(lastFeed.byName) : '',
                    )
                  : t().today.lastFeed(
                      formatClock(lastFeed.at),
                      formatVolume(lastFeed.ml, units.volume),
                      lastFeed.byName ? t().today.lastFeedBy(lastFeed.byName) : '',
                    )}
            </Muted>
            {nextSide ? (
              <Text style={s.nextSide} testID="next-breast-side">
                {t().domain.events.nextBreastSide(nextSide)}
              </Text>
            ) : null}
          </>
        )}
      </PressScale>

      <View style={s.actions}>
        <PressScale
          testID="action-feed"
          accessibilityLabel={t().today.feed}
          style={[s.action, s.actionPrimary]}
          onPress={openFeed}
        >
          <Dot color={colors.onAccent} />
          <Text style={[s.actionLabel, { color: colors.onAccent, fontWeight: '500' }]}>
            {t().today.feed}
          </Text>
        </PressScale>
        <PressScale
          testID="action-diaper"
          accessibilityLabel={t().today.diaper}
          style={s.action}
          onPress={() => sheet.open(t().today.changeDiaper, () => <DiaperSheet />)}
        >
          <Dot color={colors.diaper} />
          <Text style={s.actionLabel}>{t().today.diaper}</Text>
        </PressScale>
        <SleepAction
          sleeping={Boolean(sleeping)}
          onPress={() => void toggleSleep(Boolean(sleeping))}
        />
        <PressScale
          testID="action-more"
          accessibilityLabel={t().today.more}
          style={s.action}
          onPress={() => sheet.open(t().today.recordOther, () => <MoreSheet birthAt={birthAt} />)}
        >
          <Dot color={colors.muted} hollow />
          <Text style={s.actionLabel}>{t().today.more}</Text>
        </PressScale>
      </View>

      {insight ? (
        <View testID="insight" style={s.insight}>
          <Text style={s.insightLabel}>
            {insight.tone === 'attention' ? t().today.heedThis : t().today.fromRecords}
          </Text>
          <Text style={s.insightText}>{insight.text}</Text>
        </View>
      ) : null}

      <UpdateReadyCard />
      {events.length > 0 ? <NotificationPrompt /> : null}

      {nutritionText ? (
        <Pressable
          testID="nutrition-entry"
          accessibilityRole="button"
          accessibilityLabel={t().today.nutritionA11y(nutritionText)}
          onPress={() => router.push('/nutrition')}
          style={s.nutritionEntry}
        >
          <Text style={s.nutritionLabel}>{t().today.nutrition}</Text>
          <Muted style={s.nutritionText} numberOfLines={1} testID="nutrition-entry-text">
            {nutritionText} ›
          </Muted>
        </Pressable>
      ) : null}

      <View style={s.listHeader}>
        <View style={s.listTitleRow}>
          <Text style={s.listTitle}>{t().today.past24h}</Text>
          {/* 放在标题旁，不占快捷按钮的位置：看趋势不是半夜单手要做的事。 */}
          <Pressable
            testID="trends-open"
            accessibilityRole="button"
            accessibilityLabel={t().trends.linkA11y}
            hitSlop={LINK_HIT_SLOP}
            onPress={() => router.push('/trends')}
          >
            <Text style={s.listLink}>{t().trends.link}</Text>
          </Pressable>
        </View>
        {/* 放不下时整句换到下一行，不在句子中间折断（英文加上“Trends ›”后会挤）。 */}
        <Muted style={s.summary} testID="summary">
          {summaryText(summary, units)}
        </Muted>
      </View>
      <View style={s.list}>
        {recent.length === 0 ? (
          <View style={{ paddingVertical: 20 }}>
            <Muted style={{ fontSize: 13, lineHeight: 20 }}>{t().today.emptyTimeline}</Muted>
          </View>
        ) : (
          recent.map((entry) => (
            <TimelineRow
              key={entry.id}
              id={entry.id}
              event={entry.data}
              now={now}
              units={units}
              onPress={() =>
                sheet.open(describeEvent(entry.data, now, units), () => (
                  <EventActionsSheet id={entry.id} event={entry.data} />
                ))
              }
            />
          ))
        )}
      </View>
      {/* 放在时间线下面：补记不是半夜要做的事，不能和上面的快捷按钮抢位置。 */}
      <View style={s.listFooter}>
        <Pressable
          testID="records-open"
          accessibilityRole="button"
          accessibilityLabel={t().today.viewAll}
          hitSlop={LINK_HIT_SLOP}
          onPress={() => router.push('/records')}
        >
          <Text style={s.listLink}>{t().today.allRecords}</Text>
        </Pressable>
        {showShare ? (
          <Pressable
            testID="share-today"
            accessibilityRole="button"
            accessibilityLabel={t().share.shareTodayLink}
            hitSlop={LINK_HIT_SLOP}
            onPress={() =>
              sheet.open(t().share.sheetTitle, () => <ShareDaySheet at={Date.now()} />)
            }
          >
            <Text style={s.listLink}>{t().share.shareTodayLink}</Text>
          </Pressable>
        ) : null}
        <Pressable
          testID="backfill-open"
          accessibilityRole="button"
          accessibilityLabel={t().today.backfillA11y}
          hitSlop={LINK_HIT_SLOP}
          onPress={() =>
            sheet.open(t().today.backfill, () => <MoreSheet birthAt={birthAt} backfill />)
          }
        >
          <Text style={s.listLink}>{t().today.backfillLink}</Text>
        </Pressable>
      </View>

      {vaccine ? (
        <Pressable
          testID="vaccine-reminder"
          accessibilityRole="button"
          accessibilityLabel={t().today.vaccineReminderA11y}
          onPress={() =>
            sheet.open(t().today.vaccination, () => (
              <VaccineSheet birthAt={birthAt} preselect={vaccine.id} />
            ))
          }
          style={s.vaccineWrap}
        >
          <Card style={s.vaccineCard}>
            <Text style={s.vaccineLabel}>{t().today.vaccineReminder}</Text>
            <Text style={s.vaccineText}>{vaccineReminderText(vaccine)}</Text>
          </Card>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const sideName = (side: BreastSide) =>
  side === 'left' ? t().records.breastLeftSide : t().records.breastRightSide;

/** 亲喂计时中的喂奶卡：正在喂的一侧和它的秒表，每秒走一次，只重画这一块。 */
function BreastCard({
  feed,
  forgotten,
}: {
  feed: Extract<EventData, { type: 'feed' }>;
  forgotten: boolean;
}) {
  const now = Math.max(useNow(1000), Date.now());
  const seconds = breastSeconds(feed, now);
  const clock = (sec: number) => formatMediaDuration(sec * 1000);
  if (forgotten || !feed.side) {
    // 忘了关的计时不再一秒一秒地走，写开了多久，点进去结束。
    return (
      <>
        <View style={s.feedTop}>
          <Text style={[s.feedLabel, { color: colors.warnText }]} testID="breast-card-label">
            {t().today.breastForgotten}
          </Text>
        </View>
        <Mono weight="medium" style={s.timer} testID="feed-timer">
          {formatHoursMinutes(now - feed.at)}
        </Mono>
        <Muted testID="last-feed">{t().today.breastForgottenSub(formatClock(feed.at))}</Muted>
      </>
    );
  }
  return (
    <>
      <View style={s.feedTop}>
        <Text style={[s.feedLabel, { color: colors.accentText }]} testID="breast-card-label">
          {t().today.breastRunning}
        </Text>
      </View>
      <View style={s.breastRow}>
        <Text style={s.breastSide} testID="breast-card-side">
          {sideName(feed.side)}
        </Text>
        <Mono weight="medium" style={s.timer} testID="feed-timer">
          {clock(seconds[feed.side])}
        </Mono>
      </View>
      <Muted testID="last-feed">
        {t().today.breastRunningSub(formatClock(feed.at), clock(seconds.left + seconds.right))}
      </Muted>
    </>
  );
}

function SleepAction({ sleeping, onPress }: { sleeping: boolean; onPress: () => void }) {
  const progress = useSharedValue(sleeping ? 1 : 0);
  useEffect(() => {
    progress.value = withTiming(sleeping ? 1 : 0, { duration: 250 });
  }, [sleeping, progress]);
  // worklet 会冻结捕获的对象，先读成局部变量（scripts/check-colors.mjs）。
  const { card, line, sleepFill } = colors;
  const tint = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [card, sleepFill]),
    borderColor: interpolateColor(progress.value, [0, 1], [line, sleepFill]),
  }));
  return (
    <PressScale
      testID="action-sleep"
      accessibilityLabel={sleeping ? t().today.awake : t().today.sleep}
      style={[s.action, tint]}
      onPress={onPress}
    >
      <Dot color={sleeping ? colors.onSleep : colors.sleep} />
      <Text style={[s.actionLabel, sleeping ? { color: colors.onSleep } : null]}>
        {sleeping ? t().today.awake : t().today.sleep}
      </Text>
    </PressScale>
  );
}

const noTerms: readonly string[] = [];

export function TimelineRow({
  id,
  event,
  now,
  units,
  onPress,
  terms = noTerms,
}: {
  id: string;
  event: EventData;
  now: number;
  units: Units;
  onPress: () => void;
  /** 全部记录页搜索时要高亮的词（issue #109）。 */
  terms?: readonly string[];
}) {
  const sub = [event.note, event.byName].filter(Boolean).join(' · ');
  const title = describeEvent(event, now, units);
  return (
    <Pressable
      testID={`event-row-${id}`}
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={s.row}
    >
      <Mono style={s.rowTime}>{formatClock(event.at)}</Mono>
      <View style={{ width: 14, paddingTop: 6 }}>
        <Dot color={colors[event.type]} size={8} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.rowTitle}>
          <Highlighted text={title} terms={terms} />
        </Text>
        {sub ? (
          <Muted style={{ fontSize: 11 }}>
            <Highlighted text={sub} terms={terms} />
          </Muted>
        ) : null}
      </View>
    </Pressable>
  );
}

const s = themedStyles(() => ({
  scroll: { flex: 1, backgroundColor: colors.paper },
  header: {
    flexDirection: 'row',
    paddingHorizontal: spacing.page,
    alignItems: 'flex-start',
    gap: 12,
  },
  date: { fontSize: 12, color: colors.muted, letterSpacing: 1 },
  // 行高 31 比字体本身矮，留点内边距给下伸部分，见 primitives 的 pageTitle。
  title: {
    fontFamily: fonts.serifBold,
    fontSize: 26,
    lineHeight: 31,
    paddingBottom: 2,
    marginBottom: -2,
    color: colors.ink,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.card,
    backgroundColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedCard: {
    marginTop: 16,
    marginHorizontal: spacing.page,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 6,
  },
  feedTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 8,
  },
  feedLabel: { fontSize: 13, color: colors.muted },
  feedHint: { fontSize: 11, flexShrink: 1, textAlign: 'right' },
  timer: { fontSize: 32, lineHeight: 32, letterSpacing: -0.6 },
  breastRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  breastSide: { fontFamily: fonts.serifBold, fontSize: 20, color: colors.ink },
  nextSide: { fontSize: 12, color: colors.accentText },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12, marginHorizontal: spacing.page },
  action: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 14,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
  },
  actionPrimary: { backgroundColor: colors.accentFill, borderColor: colors.accentFill },
  actionLabel: { fontSize: 13, color: colors.ink },
  insight: {
    marginTop: 14,
    marginHorizontal: spacing.page,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.sand,
    gap: 4,
  },
  insightLabel: { fontSize: 11, color: colors.accentText, letterSpacing: 0.7 },
  insightText: { fontSize: 13, lineHeight: 21, color: colors.ink },
  listHeader: {
    marginTop: 20,
    marginHorizontal: spacing.page,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: 8,
    rowGap: 2,
  },
  summary: { flexShrink: 0, maxWidth: '100%', marginLeft: 'auto', textAlign: 'right' },
  listTitle: { fontFamily: fonts.serifBold, fontSize: 15, color: colors.ink },
  listTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  list: { marginTop: 6, marginHorizontal: spacing.page },
  listFooter: {
    marginTop: 14,
    marginHorizontal: spacing.page,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  listLink: { fontSize: 12, color: colors.accentText },
  row: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 9,
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    borderBottomColor: colors.track,
  },
  rowTime: { width: 44, fontSize: 12, color: colors.muted, paddingTop: 1 },
  rowTitle: { fontSize: 14, color: colors.ink },
  nutritionEntry: {
    marginTop: 8,
    marginHorizontal: spacing.page,
    paddingVertical: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
  },
  nutritionLabel: { fontSize: 13, color: colors.ink },
  nutritionText: { flexShrink: 1, textAlign: 'right' },
  vaccineWrap: { marginHorizontal: spacing.page, marginTop: 16 },
  vaccineCard: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, gap: 4 },
  vaccineLabel: { fontSize: 11, color: colors.greenText, letterSpacing: 0.7 },
  vaccineText: { fontSize: 13, lineHeight: 20, color: colors.ink },
}));
