import {
  dayLabel,
  formatMediaDuration,
  formatMonthDay,
  type MediaRef,
  milestoneTemplates,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useRecords } from '../lib/app';
import { gridItemWidth } from '../lib/layout';
import { AudioCard, MediaImage, PlayBadge } from '../lib/mediaViews';
import { useTabScrollRef } from '../lib/tabScroll';
import { type MomentKind, MomentSheet } from '../sheets/MomentSheet';
import { colors, fonts, spacing } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Empty, Mono, Muted, PageTitle, PressScale, Serif } from '../ui/primitives';

type SubTab = 'timeline' | 'photos' | 'milestones' | 'letters';

const TABS: { key: SubTab; label: string }[] = [
  { key: 'timeline', label: '时间线' },
  { key: 'photos', label: '照片' },
  { key: 'milestones', label: '里程碑' },
  { key: 'letters', label: '写给你' },
];

export function RecallScreen() {
  const insets = useSafeAreaInsets();
  const { role } = useApp();
  const { baby } = useRecords();
  const sheet = useSheet();
  const [tab, setTab] = useState<SubTab>('timeline');
  const canWrite = role !== 'viewer';
  const birthAt = baby?.data.birthAt ?? 0;
  const scroll = useTabScrollRef('recall');

  // 新内容排在最前面，切到对应子标签后还要回到顶部才看得到。
  const showSaved = (kind: MomentKind) => {
    setTab(kind === 'letter' ? 'letters' : 'timeline');
    scroll.current?.scrollTo({ y: 0, animated: false });
  };

  return (
    <View style={s.root} testID="recall-screen">
      <View style={[s.header, { paddingTop: insets.top + 12 }]}>
        <PageTitle>回忆</PageTitle>
        <View style={s.tabs}>
          {TABS.map((t) => {
            const on = tab === t.key;
            return (
              <Pressable
                key={t.key}
                testID={`recall-tab-${t.key}`}
                accessibilityRole="tab"
                accessibilityLabel={t.label}
                accessibilityState={{ selected: on }}
                onPress={() => setTab(t.key)}
                style={s.tab}
              >
                <View
                  style={[s.tabLabel, { borderBottomColor: on ? colors.accent : 'transparent' }]}
                >
                  <Text
                    style={{
                      fontSize: 14,
                      color: on ? colors.ink : colors.muted,
                      fontWeight: on ? '700' : '400',
                    }}
                  >
                    {t.label}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
      <ScrollView
        ref={scroll}
        contentContainerStyle={{ paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {tab === 'timeline' ? <Timeline birthAt={birthAt} /> : null}
        {tab === 'photos' ? <Photos /> : null}
        {tab === 'milestones' ? (
          <Milestones
            birthAt={birthAt}
            onSeeTimeline={() => setTab('timeline')}
            onSaved={showSaved}
          />
        ) : null}
        {tab === 'letters' ? <Letters /> : null}
      </ScrollView>
      {canWrite ? (
        <PressScale
          testID="recall-fab"
          accessibilityLabel={tab === 'letters' ? '写一封信' : '记下这一刻'}
          style={s.fab}
          onPress={() => {
            const letter = tab === 'letters';
            sheet.open(letter ? '写给宝宝的信' : '记下这一刻', () => (
              <MomentSheet
                initialKind={letter ? 'letter' : 'moment'}
                initialMilestone={tab === 'milestones'}
                onSaved={showSaved}
              />
            ));
          }}
        >
          <Text style={s.fabLabel}>{tab === 'letters' ? '＋ 写一封信' : '＋ 记下这一刻'}</Text>
        </PressScale>
      ) : null}
    </View>
  );
}

function Timeline({ birthAt }: { birthAt: number }) {
  const { moments } = useRecords();
  const router = useRouter();
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const { width } = useWindowDimensions();
  if (moments.length === 0) {
    return (
      <Empty
        title="第一个瞬间，从今天开始"
        sub="一张照片、一段哭声，或者几句话都可以。以后宝宝会想看的。"
      />
    );
  }
  const canDelete = app.role !== 'viewer';
  const openActions = (m: (typeof moments)[number]) =>
    sheet.open(m.data.title || '这一刻', () => (
      <>
        <Button
          testID="moment-edit"
          tone="outline"
          label="修改"
          onPress={() =>
            sheet.replace('修改这一刻', () => (
              <MomentSheet editMoment={{ id: m.id, data: m.data }} />
            ))
          }
        />
        <Muted style={{ fontSize: 13 }}>删除后，全家都看不到这条回忆了。</Muted>
        <Button
          testID="moment-delete"
          tone="ghost"
          label="删除这条回忆"
          onPress={() => {
            void app.remove(m.id);
            sheet.close();
            toast('已删除这条回忆', {
              undo: () => void app.write('moment', m.data, m.id),
            });
          }}
        />
      </>
    ));
  return (
    <View style={s.timeline}>
      {moments.map((m) => {
        const visual = m.data.media.filter((x) => x.kind === 'image' || x.kind === 'video');
        const audios = m.data.media.filter((x) => x.kind === 'audio');
        const cover = visual[0];
        return (
          <View key={m.id} style={{ gap: 10 }} testID={`moment-${m.id}`}>
            <View style={s.momentHeadRow}>
              <Pressable
                testID={`moment-head-${m.id}`}
                style={s.momentHead}
                accessibilityRole="button"
                accessibilityLabel={m.data.title || '这一刻'}
                onLongPress={canDelete ? () => openActions(m) : undefined}
              >
                <Text style={s.momentTitle}>{m.data.title || '这一刻'}</Text>
                <Mono style={s.momentMeta}>
                  {formatMonthDay(m.data.at)} · {dayLabel(birthAt, m.data.at)}
                </Mono>
                {m.data.milestone ? (
                  <View style={s.milestoneTag}>
                    <Text style={s.milestoneTagText}>里程碑</Text>
                  </View>
                ) : null}
              </Pressable>
              {canDelete ? (
                <Pressable
                  testID={`moment-more-${m.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${m.data.title || '这一刻'}的更多操作`}
                  hitSlop={{ top: 12, bottom: 12, left: 14, right: 14 }}
                  onPress={() => openActions(m)}
                >
                  <Text style={s.momentMore}>⋯</Text>
                </Pressable>
              ) : null}
            </View>
            {cover ? (
              <Pressable
                testID={`moment-cover-${m.id}`}
                accessibilityRole="imagebutton"
                accessibilityLabel={cover.kind === 'video' ? '播放视频' : '查看照片'}
                onPress={() =>
                  router.push({ pathname: '/viewer', params: { moment: m.id, index: 0 } })
                }
                style={s.cover}
              >
                <MediaImage
                  media={cover}
                  variant="thumb"
                  width={width}
                  style={StyleSheet.absoluteFill}
                />
                {cover.kind === 'video' ? <PlayBadge /> : null}
                {visual.length > 1 ? (
                  <View style={s.morePill}>
                    <Text style={{ fontSize: 11, color: colors.ink }}>共 {visual.length} 项</Text>
                  </View>
                ) : null}
              </Pressable>
            ) : null}
            {audios.map((a) => (
              <AudioCard key={a.id} media={a} />
            ))}
            {m.data.text ? <Serif>{m.data.text}</Serif> : null}
            {m.data.byName ? <Muted style={{ fontSize: 11 }}>{m.data.byName}写</Muted> : null}
          </View>
        );
      })}
    </View>
  );
}

const PHOTO_GAP = 4;

function Photos() {
  const { moments } = useRecords();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  const cellWidth = gridItemWidth(windowWidth - spacing.page * 2, 3, PHOTO_GAP);
  const groups = moments
    .map((m) => ({
      moment: m,
      cells: m.data.media.filter((x) => x.kind === 'image' || x.kind === 'video'),
    }))
    .filter((g) => g.cells.length > 0);
  if (groups.length === 0) {
    return <Empty title="还没有照片" sub="点右下角「记下这一刻」，从相册选几张吧。" />;
  }
  return (
    <View style={s.photos}>
      {groups.map(({ moment, cells }) => (
        <View key={moment.id} style={{ gap: 8 }}>
          <View style={s.groupHead}>
            <Text style={s.groupTitle} numberOfLines={1}>
              {moment.data.title || '这一刻'} · {formatMonthDay(moment.data.at)}
            </Text>
            <Muted>{cells.length} 项</Muted>
          </View>
          <View style={s.grid}>
            {cells.map((cell: MediaRef, index) => (
              <Pressable
                key={cell.id}
                testID={`photo-${cell.id}`}
                accessibilityRole="imagebutton"
                accessibilityLabel={cell.kind === 'video' ? '播放视频' : '查看照片'}
                style={[s.gridCell, { width: cellWidth, height: cellWidth }]}
                onPress={() =>
                  router.push({ pathname: '/viewer', params: { moment: moment.id, index } })
                }
              >
                <MediaImage media={cell} variant="thumb" style={StyleSheet.absoluteFill} />
                {cell.kind === 'video' ? (
                  <View style={s.durationPill}>
                    <Mono weight="medium" style={{ fontSize: 10, color: colors.white }}>
                      ▶ {cell.durationMs ? formatMediaDuration(cell.durationMs) : ''}
                    </Mono>
                  </View>
                ) : null}
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function Milestones({
  birthAt,
  onSeeTimeline,
  onSaved,
}: {
  birthAt: number;
  onSeeTimeline: () => void;
  onSaved: (kind: MomentKind) => void;
}) {
  const { moments } = useRecords();
  const { role } = useApp();
  const sheet = useSheet();
  const done = moments.filter((m) => m.data.milestone);
  const pending = milestoneTemplates.filter((t) => !done.some((m) => m.data.title === t.title));
  return (
    <View style={s.milestones}>
      {done.map((m) => (
        <Pressable
          key={m.id}
          testID={`milestone-done-${m.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${m.data.title}，查看`}
          onPress={onSeeTimeline}
          style={s.milestoneRow}
        >
          <View style={s.milestoneDotColumn}>
            <View
              style={[
                s.milestoneDot,
                { borderColor: colors.accent, backgroundColor: colors.accent },
              ]}
            />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 14, color: colors.ink }}>{m.data.title || '这一刻'}</Text>
            <Muted style={{ fontSize: 11 }}>
              {formatMonthDay(m.data.at)} · {dayLabel(birthAt, m.data.at)}
            </Muted>
          </View>
          <Text style={s.milestoneAction}>查看</Text>
        </Pressable>
      ))}
      {pending.map((t) => (
        <Pressable
          key={t.title}
          testID={`milestone-${t.title}`}
          accessibilityRole="button"
          accessibilityLabel={`${t.title}，记录`}
          disabled={role === 'viewer'}
          onPress={() =>
            sheet.open('记下这一刻', () => (
              <MomentSheet
                initialKind="moment"
                initialMilestone
                initialTitle={t.title}
                onSaved={onSaved}
              />
            ))
          }
          style={s.milestoneRow}
        >
          <View style={s.milestoneDotColumn}>
            <View style={[s.milestoneDot, { borderColor: colors.hint }]} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 14, color: colors.muted }}>{t.title}</Text>
            <Muted style={{ fontSize: 11 }}>{t.typical}</Muted>
          </View>
          {role === 'viewer' ? null : <Text style={s.milestoneAction}>记录</Text>}
        </Pressable>
      ))}
      <Muted style={{ marginTop: 14, fontSize: 11, lineHeight: 18 }}>
        月龄只是大致参考，每个宝宝节奏不同。
      </Muted>
    </View>
  );
}

function Letters() {
  const { letters } = useRecords();
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  if (letters.length === 0) {
    return (
      <Empty title="写一封信给长大后的宝宝" sub="现在的心情，等宝宝长大了再读，会很不一样。" />
    );
  }
  const canWrite = app.role !== 'viewer';
  const openActions = (l: (typeof letters)[number]) =>
    sheet.open(l.data.title || '无题', () => (
      <>
        <Button
          testID="letter-edit"
          tone="outline"
          label="修改"
          onPress={() =>
            sheet.replace('修改这封信', () => (
              <MomentSheet editLetter={{ id: l.id, data: l.data }} />
            ))
          }
        />
        <Muted style={{ fontSize: 13 }}>删除后，全家都看不到这封信了。</Muted>
        <Button
          testID="letter-delete"
          tone="ghost"
          label="删除这封信"
          onPress={() => {
            void app.remove(l.id);
            sheet.close();
            toast('已删除这封信', {
              undo: () => void app.write('letter', l.data, l.id),
            });
          }}
        />
      </>
    ));
  return (
    <View style={s.letters}>
      {letters.map((l) => (
        <View key={l.id} style={s.letter} testID={`letter-${l.id}`}>
          <View style={s.letterHead}>
            <Text style={s.letterTitle}>{l.data.title || '无题'}</Text>
            <Mono style={{ fontSize: 11, color: colors.muted }}>{formatMonthDay(l.data.at)}</Mono>
            {canWrite ? (
              <Pressable
                testID={`letter-more-${l.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${l.data.title || '无题'}的更多操作`}
                hitSlop={{ top: 12, bottom: 12, left: 14, right: 14 }}
                onPress={() => openActions(l)}
              >
                <Text style={s.momentMore}>⋯</Text>
              </Pressable>
            ) : null}
          </View>
          <Serif style={{ fontSize: 13, color: colors.inkSoft, lineHeight: 23 }}>
            {l.data.text}
          </Serif>
          {l.data.byName ? <Muted style={{ fontSize: 11 }}>{l.data.byName}写</Muted> : null}
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  // zIndex：子标签的点击区伸到了头部下方，要压过后面的滚动区。
  header: { paddingHorizontal: spacing.page, gap: 12, zIndex: 1 },
  // 上下各 9 的内边距把点击区撑到 44，负外边距抵消，看起来位置不变。
  tabs: { flexDirection: 'row', gap: 18, marginVertical: -9 },
  tab: { minHeight: 44, paddingVertical: 9, justifyContent: 'center' },
  tabLabel: { borderBottomWidth: 2, paddingBottom: 4 },
  timeline: { paddingHorizontal: spacing.page, paddingTop: 18, gap: 28 },
  momentHeadRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  momentHead: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  momentTitle: { fontFamily: fonts.serifBold, fontSize: 18, color: colors.ink },
  momentMeta: { fontSize: 12, color: colors.muted },
  momentMore: { fontSize: 16, lineHeight: 26, color: colors.muted },
  milestoneTag: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  milestoneTagText: { fontSize: 10, color: colors.accent },
  cover: { height: 200, borderRadius: 14, overflow: 'hidden', backgroundColor: colors.line },
  morePill: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(255,253,249,0.92)',
  },
  photos: { paddingHorizontal: spacing.page, paddingTop: 18, gap: 20 },
  groupHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 8,
  },
  groupTitle: { fontFamily: fonts.serifBold, fontSize: 15, color: colors.ink, flexShrink: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: PHOTO_GAP },
  gridCell: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.line,
  },
  durationPill: {
    position: 'absolute',
    right: 5,
    bottom: 5,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: 'rgba(43,38,34,0.6)',
  },
  milestones: { paddingHorizontal: spacing.page, paddingTop: 14 },
  milestoneRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#efe7dc',
  },
  milestoneDotColumn: { width: 22 },
  milestoneDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5 },
  milestoneAction: { fontSize: 12, color: colors.accent },
  letters: { paddingHorizontal: spacing.page, paddingTop: 18, gap: 12 },
  letter: {
    padding: 16,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    gap: 8,
  },
  letterHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 8,
  },
  letterTitle: { fontFamily: fonts.serifBold, fontSize: 16, color: colors.ink, flex: 1 },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 19,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: colors.ink,
    elevation: 6,
    shadowColor: colors.ink,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 6 },
  },
  fabLabel: { fontSize: 14, color: colors.paper },
});
