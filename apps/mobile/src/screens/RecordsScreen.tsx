import {
  describeEvent,
  type EventData,
  eventsByDay,
  formatDateHeader,
  formatFullDate,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useRecords, useUnits } from '../lib/app';
import { EventActionsSheet, MoreSheet } from '../sheets/recordSheets';
import { colors, spacing } from '../theme';
import { useSheet } from '../ui/overlays';
import { Chip, Empty, PageTitle } from '../ui/primitives';
import { TimelineRow } from './TodayScreen';

type Filter = 'all' | EventData['type'];

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'feed', label: '喂奶' },
  { key: 'diaper', label: '尿布' },
  { key: 'sleep', label: '睡眠' },
  { key: 'temp', label: '体温' },
  { key: 'med', label: '吃药' },
  { key: 'bath', label: '洗澡' },
  { key: 'solids', label: '辅食' },
  { key: 'growth', label: '身高体重' },
  { key: 'vaccine', label: '疫苗' },
];

function dayTitle(dayStart: number, now: number): string {
  const sameYear = new Date(dayStart).getFullYear() === new Date(now).getFullYear();
  return sameYear ? formatDateHeader(dayStart) : formatFullDate(dayStart);
}

/** 今天页只有过去 24 小时的 8 条，更早的、身高体重都要到这里才能点开修改。 */
export function RecordsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { role } = useApp();
  const { events, baby } = useRecords();
  const units = useUnits();
  const sheet = useSheet();
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
            accessibilityLabel="返回今天"
            hitSlop={12}
            onPress={() => router.back()}
          >
            <Text style={s.back}>‹ 今天</Text>
          </Pressable>
          {canWrite ? (
            <Pressable
              testID="records-backfill"
              accessibilityRole="button"
              accessibilityLabel="补记以前的记录"
              hitSlop={12}
              onPress={() => sheet.open('补记', () => <MoreSheet birthAt={birthAt} backfill />)}
            >
              <Text style={s.link}>＋ 补记</Text>
            </Pressable>
          ) : null}
        </View>
        <PageTitle>全部记录</PageTitle>
        <View style={s.filters}>
          {FILTERS.map((f) => (
            <Chip
              key={f.key}
              testID={`records-filter-${f.key}`}
              label={f.label}
              selected={filter === f.key}
              onPress={() => setFilter(f.key)}
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
            title={filter === 'all' ? '还没有记录' : '这一类还没有记录'}
            sub={canWrite ? '以前的也可以补记，点右上角就行。' : undefined}
          />
        }
        renderSectionHeader={({ section }) => (
          <Text style={s.dayTitle} testID={`records-day-${section.dayStart}`}>
            {dayTitle(section.dayStart, now)}
          </Text>
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
  dayTitle: {
    marginTop: 18,
    marginBottom: 2,
    marginHorizontal: spacing.page,
    fontSize: 12,
    color: colors.muted,
    letterSpacing: 1,
  },
  item: { marginHorizontal: spacing.page },
});
