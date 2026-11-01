import {
  activeSleep,
  ageText,
  dayNumber,
  describeEvent,
  type EventData,
  estimateNextFeed,
  eventColors,
  formatClock,
  formatDateHeader,
  formatDuration,
  formatHoursMinutes,
  nextVaccine,
  summarize24h,
  summaryText,
  todayInsight,
  vaccineStatuses,
} from '@xiaodouya/shared';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useNow, useRecords } from '../lib/app';
import { MediaImage } from '../lib/mediaViews';
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

export function TodayScreen() {
  const insets = useSafeAreaInsets();
  const app = useApp();
  const { events, baby, pendingCount } = useRecords();
  const sheet = useSheet();
  const { toast } = useFeedback();
  // 只用来定时刷新。过滤记录要用渲染时的时间：否则刚保存的记录比 now 新，最多 15 秒不显示，家长可能重复记录。
  useNow(15_000);
  const now = Date.now();
  const [refreshing, setRefreshing] = useState(false);

  if (!baby) return <SyncingPlaceholder />;
  const birthAt = baby.data.birthAt;
  const data = events.map((e) => e.data);
  const estimate = estimateNextFeed(data, now);
  const sleeping = activeSleep(data);
  const sleepingEntry = sleeping ? events.find((e) => e.data === sleeping) : undefined;
  const summary = summarize24h(data, now);
  const insight = todayInsight(data, birthAt, now);
  const recent = events.filter((e) => e.data.type !== 'growth' && e.data.at <= now).slice(0, 8);
  const statuses = vaccineStatuses(birthAt, data, now);
  const vaccine = nextVaccine(statuses);

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

  const openFeed = () => sheet.open('喂奶', () => <FeedSheet />);
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
      testID="today-screen"
      style={s.scroll}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 24 }}
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
          <Text accessibilityRole="header" style={s.title} testID="today-title">
            {baby.data.name}的第 {dayNumber(birthAt, now)} 天
          </Text>
          <Muted>{ageText(birthAt, now)}</Muted>
          {syncLine ? (
            <Muted testID="sync-status" style={{ color: colors.accent, fontSize: 11 }}>
              {syncLine}
            </Muted>
          ) : null}
        </View>
        <View style={s.avatar}>
          {baby.data.avatar ? (
            <MediaImage media={baby.data.avatar} variant="thumb" style={StyleSheet.absoluteFill} />
          ) : (
            <Stripes style={StyleSheet.absoluteFill} />
          )}
        </View>
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
            ? `${formatClock(estimate.last.at)} 喂奶 ${estimate.last.ml}ml${
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
        <PressScale
          testID="action-sleep"
          accessibilityLabel={sleeping ? '醒了' : '睡眠'}
          style={[
            s.action,
            sleeping ? { backgroundColor: colors.sleep, borderColor: colors.sleep } : null,
          ]}
          onPress={() => void toggleSleep()}
        >
          <Dot color={sleeping ? colors.white : colors.sleep} />
          <Text style={[s.actionLabel, sleeping ? { color: colors.white } : null]}>
            {sleeping ? '醒了' : '睡眠'}
          </Text>
        </PressScale>
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
          {summaryText(summary)}
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
              onPress={() =>
                sheet.open(describeEvent(entry.data, now), () => (
                  <EventActionsSheet id={entry.id} event={entry.data} />
                ))
              }
            />
          ))
        )}
      </View>

      {vaccine ? (
        <Pressable
          testID="vaccine-reminder"
          accessibilityRole="button"
          accessibilityLabel="疫苗提醒"
          onPress={() =>
            sheet.open('疫苗接种', () => <VaccineSheet birthAt={birthAt} preselect={vaccine.id} />)
          }
          style={{ marginHorizontal: spacing.page, marginTop: 16 }}
        >
          <Card style={s.vaccineCard}>
            <Text style={s.vaccineLabel}>疫苗提醒</Text>
            <Text style={s.vaccineText}>
              {vaccine.name}，{vaccine.ageLabel}可接种。打完点这里在疫苗本里记一笔。
            </Text>
          </Card>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function TimelineRow({
  id,
  event,
  now,
  onPress,
}: {
  id: string;
  event: EventData;
  now: number;
  onPress: () => void;
}) {
  const sub = [event.note, event.byName].filter(Boolean).join(' · ');
  return (
    <Pressable
      testID={`event-row-${id}`}
      accessibilityRole="button"
      accessibilityLabel={describeEvent(event, now)}
      onPress={onPress}
      style={s.row}
    >
      <Mono style={s.rowTime}>{formatClock(event.at)}</Mono>
      <View style={{ width: 14, paddingTop: 6 }}>
        <Dot color={eventColors[event.type]} size={8} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.rowTitle}>{describeEvent(event, now)}</Text>
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
  title: { fontFamily: fonts.serifBold, fontSize: 26, lineHeight: 34, color: colors.ink },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.white,
    backgroundColor: colors.line,
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
  timer: { fontSize: 32, lineHeight: 38, letterSpacing: -0.6 },
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
  vaccineCard: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, gap: 4 },
  vaccineLabel: { fontSize: 11, color: colors.green, letterSpacing: 0.7 },
  vaccineText: { fontSize: 13, lineHeight: 20, color: colors.ink },
});
