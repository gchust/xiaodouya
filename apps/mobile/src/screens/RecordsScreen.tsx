import { describeEvent, type EventData, eventsByDay, startOfLocalDay, t } from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useRecords, useUnits } from '../lib/app';
import { shareDayTitle } from '../lib/share';
import { EventActionsSheet, MoreSheet } from '../sheets/recordSheets';
import { ShareDaySheet, useCanShare } from '../sheets/shareSheets';
import { colors, spacing } from '../theme';
import { useSheet } from '../ui/overlays';
import { Chip, Empty, PageTitle } from '../ui/primitives';
import { TimelineRow } from './TodayScreen';

type Filter = 'all' | EventData['type'];

const filters = (): { key: Filter; label: string }[] => [
  { key: 'all', label: t().today.filterAll },
  { key: 'feed', label: t().today.feed },
  { key: 'diaper', label: t().today.diaper },
  { key: 'sleep', label: t().today.sleep },
  { key: 'temp', label: t().today.filterTemp },
  { key: 'med', label: t().today.filterMed },
  { key: 'bath', label: t().today.filterBath },
  { key: 'solids', label: t().today.filterSolids },
  { key: 'growth', label: t().today.filterGrowth },
  { key: 'vaccine', label: t().today.filterVaccine },
];

/** 今天页只有过去 24 小时的 8 条，更早的、身高体重都要到这里才能点开修改。 */
export function RecordsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { role } = useApp();
  const { events, baby } = useRecords();
  const units = useUnits();
  const sheet = useSheet();
  const showShare = useCanShare();
  const [filter, setFilter] = useState<Filter>('all');
  const now = Date.now();
  const sections = useMemo(
    () =>
      eventsByDay(filter === 'all' ? events : events.filter((e) => e.data.type === filter)).map(
        (day) => ({ ...day, key: String(day.dayStart) }),
      ),
    [events, filter],
  );
  const canWrite = role !== 'viewer';
  const birthAt = baby?.data.birthAt ?? 0;

  return (
    <View style={s.root} testID="records-screen">
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <View style={s.topRow}>
          <Pressable
            testID="records-back"
            accessibilityRole="button"
            accessibilityLabel={t().today.backToToday}
            hitSlop={12}
            onPress={() => router.back()}
          >
            <Text style={s.back}>{t().today.backTodayLink}</Text>
          </Pressable>
          {canWrite ? (
            <Pressable
              testID="records-backfill"
              accessibilityRole="button"
              accessibilityLabel={t().today.backfillA11y}
              hitSlop={12}
              onPress={() =>
                sheet.open(t().today.backfill, () => <MoreSheet birthAt={birthAt} backfill />)
              }
            >
              <Text style={s.link}>{t().today.backfillLink}</Text>
            </Pressable>
          ) : null}
        </View>
        <PageTitle>{t().today.allRecordsTitle}</PageTitle>
        <View style={s.filters}>
          {filters().map((f) => (
            <Chip
              key={f.key}
              testID={`records-filter-${f.key}`}
              label={f.label}
              selected={filter === f.key}
              onPress={() => setFilter(f.key)}
              // 胶囊默认的底色和这一页的背景相同，看起来像一排普通文字。
              style={filter === f.key ? null : s.filterOff}
            />
          ))}
        </View>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(entry) => entry.id}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        ListEmptyComponent={
          <Empty
            title={filter === 'all' ? t().today.noRecords : t().today.noRecordsFilter}
            sub={canWrite ? t().today.addOlderHint : undefined}
          />
        }
        renderSectionHeader={({ section }) => (
          <View style={s.dayRow}>
            <Text style={s.dayTitle} testID={`records-day-${section.dayStart}`}>
              {shareDayTitle(section.dayStart, now)}
            </Text>
            {showShare ? (
              <Pressable
                // testID 不能带时间戳：Maestro 算不出来。今天的固定一个名字。
                testID={
                  section.dayStart === startOfLocalDay(now)
                    ? 'records-share-today'
                    : `records-share-${section.dayStart}`
                }
                accessibilityRole="button"
                accessibilityLabel={t().share.shareDayA11y(shareDayTitle(section.dayStart, now))}
                hitSlop={12}
                onPress={() =>
                  sheet.open(t().share.sheetTitle, () => <ShareDaySheet at={section.dayStart} />)
                }
              >
                <Text style={s.dayShare}>{t().share.shareLink}</Text>
              </Pressable>
            ) : null}
          </View>
        )}
        renderItem={({ item }) => (
          <View style={s.item}>
            <TimelineRow
              id={item.id}
              event={item.data}
              now={now}
              units={units}
              onPress={() => {
                if (!canWrite) return;
                sheet.open(describeEvent(item.data, Date.now(), units), () => (
                  <EventActionsSheet id={item.id} event={item.data} />
                ));
              }}
            />
          </View>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  header: { paddingHorizontal: spacing.page, gap: 8 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  link: { fontSize: 13, color: colors.accent, padding: 4 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  filterOff: { backgroundColor: colors.card },
  dayRow: {
    marginTop: 18,
    marginBottom: 2,
    marginHorizontal: spacing.page,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  dayTitle: { flexShrink: 1, fontSize: 12, color: colors.muted, letterSpacing: 1 },
  dayShare: { fontSize: 12, color: colors.accent },
  item: { marginHorizontal: spacing.page },
});
