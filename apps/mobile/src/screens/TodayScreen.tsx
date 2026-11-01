import {
  activeSleep,
  ageText,
  dayNumber,
  describeEvent,
  dueVaccine,
  type EventData,
  estimateNextFeed,
  eventColors,
  formatClock,
  formatDateHeader,
  formatDuration,
  formatHoursMinutes,
  formatVolume,
  planSchedule,
  summarize24h,
  summaryText,
  timelineEntries,
  todayInsight,
  type Units,
  vaccineReminderText,
  vaccineStatuses,
} from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
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
import { pickFromLibrary, queueForUpload } from '../lib/media';
import { MediaImage } from '../lib/mediaViews';
import { useTabScrollRef } from '../lib/tabScroll';
import {
  DiaperSheet,
  EventActionsSheet,
  FeedSheet,
  MoreSheet,
  VaccineSheet,
} from '../sheets/recordSheets';
import { colors, fonts, spacing } from '../theme';
import { NotificationPrompt } from '../ui/NotificationPrompt';
import { useFeedback, useSheet } from '../ui/overlays';
import { Card, Dot, Mono, Muted, PressScale, Stripes } from '../ui/primitives';
import { SyncingPlaceholder } from '../ui/SyncingPlaceholder';

/** 链接文字只有 16 高，上下各扩 14 才到 44。 */
const LINK_HIT_SLOP = { top: 14, bottom: 14, left: 12, right: 12 };

export function TodayScreen() {
  const insets = useSafeAreaInsets();
  const scrollRef = useTabScrollRef('today');
  const app = useApp();
  const { events, baby, pendingCount, vaccinePlans } = useRecords();
  const region = useRegion();
  const units = useUnits();
  const sheet = useSheet();
  const router = useRouter();
  const { toast } = useFeedback();
  // 只用来定时刷新。过滤记录要用渲染时的时间：否则刚保存的记录比 now 新，最多 15 秒不显示，家长可能重复记录。
  useNow(15_000);
  const now = Date.now();
  const [refreshing, setRefreshing] = useState(false);
  const [changingAvatar, setChangingAvatar] = useState(false);

  if (!baby) return <SyncingPlaceholder />;
  const birthAt = baby.data.birthAt;
  const data = events.map((e) => e.data);
  const estimate = estimateNextFeed(data, now);
  const sleeping = activeSleep(data);
  const sleepingEntry = sleeping ? events.find((e) => e.data === sleeping) : undefined;
  const summary = summarize24h(data, now);
  const insight = todayInsight(data, birthAt, now);
  const recent = timelineEntries(events, now);
  const vaccine = dueVaccine(
    vaccineStatuses(planSchedule(region, birthAt, vaccinePlans, data), birthAt, data, now),
  );

  const feedHint = !estimate.last
    ? ''
    : !estimate.isLearned
      ? '记录几次后会估算下次时间'
      : estimate.remainingMs > 0
        ? `约 ${formatDuration(estimate.remainingMs)}后该喂了`
        : '已到平时的喂奶间隔';
  const feedHintNear = estimate.isLearned && estimate.remainingMs < 30 * 60_000;

  const toggleSleep = async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (sleeping && sleepingEntry) {
      const end = Date.now();
      await app.write('event', { ...sleeping, endAt: end }, sleepingEntry.id);
      toast(`醒了 · 这次睡了 ${formatDuration(end - sleeping.at)}`);
    } else {
      const id = await app.write('event', { type: 'sleep', at: Date.now(), byName: app.label });
      toast('开始记录睡眠，醒了再点一下', { undo: () => void app.remove(id) });
    }
  };

  const changeAvatar = async () => {
    setChangingAvatar(true);
    try {
      const [file] = await pickFromLibrary({ singleImage: true });
      if (!file) return;
      const avatar = await queueForUpload(app.uploads, file, {
        id: Crypto.randomUUID(),
        scope: 'avatar',
        videoWifiOnly: false,
      });
      // 选照片可能花了一会儿，用最新的档案，不要盖掉家人刚改的内容。
      const latest = app.store.getSnapshot().baby ?? baby;
      await app.write('baby', { ...latest.data, avatar }, latest.id);
      toast('头像换好了');
    } catch (error) {
      toast(error instanceof Error ? error.message : '头像没有换成，请再试一次');
    } finally {
      setChangingAvatar(false);
    }
  };

  const openFeed = () => sheet.open('喂奶', () => <FeedSheet />);
  const canChangeAvatar = app.role !== 'viewer';
  const syncLine =
    app.syncStatus === 'offline'
      ? pendingCount > 0
        ? `离线中 · ${pendingCount} 条待同步，已安全保存在手机上`
        : '离线中 · 记录照常保存'
      : pendingCount > 0
        ? `正在同步 ${pendingCount} 条记录`
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
            {baby.data.name}的第 {dayNumber(birthAt, now)} 天
          </Text>
          <Muted>{ageText(birthAt, now)}</Muted>
          {syncLine ? (
            <Muted testID="sync-status" style={{ color: colors.accent, fontSize: 11 }}>
              {syncLine}
            </Muted>
          ) : null}
        </View>
        <PressScale
          testID="baby-avatar"
          accessibilityLabel="换宝宝的头像"
          accessibilityState={{ busy: changingAvatar, disabled: !canChangeAvatar }}
          disabled={changingAvatar || !canChangeAvatar}
          style={s.avatar}
          onPress={() => void changeAvatar()}
        >
          {baby.data.avatar ? (
            <MediaImage media={baby.data.avatar} variant="thumb" style={StyleSheet.absoluteFill} />
          ) : (
            <Stripes style={StyleSheet.absoluteFill} />
          )}
          {changingAvatar ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        </PressScale>
      </View>

      <PressScale
        testID="feed-card"
        accessibilityLabel="距上次喂奶，点击记录喂奶"
        scaleTo={0.98}
        onPress={openFeed}
        style={s.feedCard}
      >
        <View style={s.feedTop}>
          <Text style={s.feedLabel}>距上次喂奶</Text>
          <Text style={[s.feedHint, { color: feedHintNear ? colors.accent : colors.muted }]}>
            {feedHint}
          </Text>
        </View>
        <Mono weight="medium" style={s.timer} testID="feed-timer">
          {estimate.last ? formatHoursMinutes(estimate.sinceMs) : '—'}
        </Mono>
        <Muted testID="last-feed">
          {estimate.last
            ? `${formatClock(estimate.last.at)} 喂奶 ${formatVolume(estimate.last.ml, units.volume)}${
                estimate.last.byName ? ` · ${estimate.last.byName}记录` : ''
              }`
            : '还没有喂奶记录，点这里记第一次'}
        </Muted>
      </PressScale>

      <View style={s.actions}>
        <PressScale
          testID="action-feed"
          accessibilityLabel="喂奶"
          style={[s.action, s.actionPrimary]}
          onPress={openFeed}
        >
          <Dot color={colors.white} />
          <Text style={[s.actionLabel, { color: colors.white, fontWeight: '500' }]}>喂奶</Text>
        </PressScale>
        <PressScale
          testID="action-diaper"
          accessibilityLabel="尿布"
          style={s.action}
          onPress={() => sheet.open('换尿布', () => <DiaperSheet />)}
        >
          <Dot color={colors.diaper} />
          <Text style={s.actionLabel}>尿布</Text>
        </PressScale>
        <SleepAction sleeping={Boolean(sleeping)} onPress={() => void toggleSleep()} />
        <PressScale
          testID="action-more"
          accessibilityLabel="更多"
          style={s.action}
          onPress={() => sheet.open('记录其他', () => <MoreSheet birthAt={birthAt} />)}
        >
          <Dot color={colors.muted} hollow />
          <Text style={s.actionLabel}>更多</Text>
        </PressScale>
      </View>

      {insight ? (
        <View testID="insight" style={s.insight}>
          <Text style={s.insightLabel}>
            {insight.tone === 'attention' ? '留意一下' : '根据记录'}
          </Text>
          <Text style={s.insightText}>{insight.text}</Text>
        </View>
      ) : null}

      {events.length > 0 ? <NotificationPrompt /> : null}

      <View style={s.listHeader}>
        <Text style={s.listTitle}>过去 24 小时</Text>
        <Muted style={{ textAlign: 'right', flexShrink: 1 }} testID="summary">
          {summaryText(summary, units)}
        </Muted>
      </View>
      <View style={s.list}>
        {recent.length === 0 ? (
          <View style={{ paddingVertical: 20 }}>
            <Muted style={{ fontSize: 13, lineHeight: 20 }}>
              这里会按时间列出每一次喂奶、换尿布和睡眠。点上面的按钮开始吧。
            </Muted>
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
          accessibilityLabel="查看全部记录"
          hitSlop={LINK_HIT_SLOP}
          onPress={() => router.push('/records')}
        >
          <Text style={s.listLink}>全部记录 ›</Text>
        </Pressable>
        <Pressable
          testID="backfill-open"
          accessibilityRole="button"
          accessibilityLabel="补记以前的记录"
          hitSlop={LINK_HIT_SLOP}
          onPress={() => sheet.open('补记', () => <MoreSheet birthAt={birthAt} backfill />)}
        >
          <Text style={s.listLink}>＋ 补记</Text>
        </Pressable>
      </View>

      {vaccine ? (
        <Pressable
          testID="vaccine-reminder"
          accessibilityRole="button"
          accessibilityLabel="疫苗提醒"
          onPress={() =>
            sheet.open('疫苗接种', () => <VaccineSheet birthAt={birthAt} preselect={vaccine.id} />)
          }
          style={s.vaccineWrap}
        >
          <Card style={s.vaccineCard}>
            <Text style={s.vaccineLabel}>疫苗提醒</Text>
            <Text style={s.vaccineText}>{vaccineReminderText(vaccine)}</Text>
          </Card>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function SleepAction({ sleeping, onPress }: { sleeping: boolean; onPress: () => void }) {
  const progress = useSharedValue(sleeping ? 1 : 0);
  useEffect(() => {
    progress.value = withTiming(sleeping ? 1 : 0, { duration: 250 });
  }, [sleeping, progress]);
  const tint = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [colors.card, colors.sleep]),
    borderColor: interpolateColor(progress.value, [0, 1], [colors.line, colors.sleep]),
  }));
  return (
    <PressScale
      testID="action-sleep"
      accessibilityLabel={sleeping ? '醒了' : '睡眠'}
      style={[s.action, tint]}
      onPress={onPress}
    >
      <Dot color={sleeping ? colors.white : colors.sleep} />
      <Text style={[s.actionLabel, sleeping ? { color: colors.white } : null]}>
        {sleeping ? '醒了' : '睡眠'}
      </Text>
    </PressScale>
  );
}

export function TimelineRow({
  id,
  event,
  now,
  units,
  onPress,
}: {
  id: string;
  event: EventData;
  now: number;
  units: Units;
  onPress: () => void;
}) {
  const sub = [event.note, event.byName].filter(Boolean).join(' · ');
  return (
    <Pressable
      testID={`event-row-${id}`}
      accessibilityRole="button"
      accessibilityLabel={describeEvent(event, now, units)}
      onPress={onPress}
      style={s.row}
    >
      <Mono style={s.rowTime}>{formatClock(event.at)}</Mono>
      <View style={{ width: 14, paddingTop: 6 }}>
        <Dot color={eventColors[event.type]} size={8} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.rowTitle}>{describeEvent(event, now, units)}</Text>
        {sub ? <Muted style={{ fontSize: 11 }}>{sub}</Muted> : null}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
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
    borderColor: colors.white,
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
  actionPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
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
  insightLabel: { fontSize: 11, color: colors.accent, letterSpacing: 0.7 },
  insightText: { fontSize: 13, lineHeight: 21, color: colors.ink },
  listHeader: {
    marginTop: 20,
    marginHorizontal: spacing.page,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 8,
  },
  listTitle: { fontFamily: fonts.serifBold, fontSize: 15, color: colors.ink },
  list: { marginTop: 6, marginHorizontal: spacing.page },
  listFooter: {
    marginTop: 14,
    marginHorizontal: spacing.page,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  listLink: { fontSize: 12, color: colors.accent },
  row: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 9,
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    borderBottomColor: '#efe7dc',
  },
  rowTime: { width: 44, fontSize: 12, color: colors.muted, paddingTop: 1 },
  rowTitle: { fontSize: 14, color: colors.ink },
  vaccineWrap: { marginHorizontal: spacing.page, marginTop: 16 },
  vaccineCard: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, gap: 4 },
  vaccineLabel: { fontSize: 11, color: colors.green, letterSpacing: 0.7 },
  vaccineText: { fontSize: 13, lineHeight: 20, color: colors.ink },
});
