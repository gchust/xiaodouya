import {
  dayLabel,
  formatMediaDuration,
  formatMonthDay,
  MAX_SHARE_MOMENTS,
  type MediaRef,
  milestoneTemplates,
  momentCover,
  t,
  visualMedia,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useRecords } from '../lib/app';
import { downloadFileNames } from '../lib/downloadCore';
import { gridItemWidth } from '../lib/layout';
import { useFavorites } from '../lib/library';
import { AudioCard, MediaImage, PlayBadge } from '../lib/mediaViews';
import { toggleSelection } from '../lib/share';
import { useTabScrollRef } from '../lib/tabScroll';
import { FolderPicker } from '../sheets/librarySheets';
import { type MomentKind, MomentSheet } from '../sheets/MomentSheet';
import { ShareMomentsSheet } from '../sheets/shareMomentsSheet';
import { useCanShare } from '../sheets/shareSheets';
import { ShareTimelineSheet } from '../sheets/shareTimelineSheet';
import { colors, fonts, spacing } from '../theme';
import { useDeleteConfirm } from '../ui/DeleteConfirm';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Empty, Mono, Muted, PageTitle, PressScale, Serif } from '../ui/primitives';
import { StarButton } from '../ui/ResourceRow';

type SubTab = 'timeline' | 'photos' | 'milestones' | 'letters';

/** 链接文字只有 18 高，上下各扩 13 才到 44。 */
const LINK_HIT_SLOP = { top: 13, bottom: 13, left: 12, right: 12 };

const tabs = (): { key: SubTab; label: string }[] => [
  { key: 'timeline', label: t().recall.timeline },
  { key: 'photos', label: t().recall.photos },
  { key: 'milestones', label: t().recall.milestones },
  { key: 'letters', label: t().recall.letters },
];

export function RecallScreen() {
  const insets = useSafeAreaInsets();
  const { role } = useApp();
  const { baby, moments } = useRecords();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const [tab, setTab] = useState<SubTab>('timeline');
  /** 选几段回忆一起分享（F-136）。null 是没在选。 */
  const [selection, setSelection] = useState<readonly string[] | null>(null);
  const canWrite = role !== 'viewer';
  const birthAt = baby?.data.birthAt ?? 0;
  const scroll = useTabScrollRef('recall');
  const canShare = useCanShare();

  // 新内容排在最前面，切到对应子标签后还要回到顶部才看得到。
  const showSaved = (kind: MomentKind) => {
    setTab(kind === 'letter' ? 'letters' : 'timeline');
    scroll.current?.scrollTo({ y: 0, animated: false });
  };

  const selecting = selection !== null && tab === 'timeline' && canShare;
  // 家人在别的手机上删掉的那段，选中的列表里也跟着拿掉。
  const selected = selecting ? selection.filter((id) => moments.some((m) => m.id === id)) : [];
  const toggle = (id: string) => {
    if (!selection) return;
    const next = toggleSelection(selection, id);
    if (next === selection) toast(t().share.momentsFull(MAX_SHARE_MOMENTS));
    setSelection(next);
  };

  // 选择模式里按返回键是退出选择，不是离开回忆页。
  useEffect(() => {
    if (!selecting) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelection(null);
      return true;
    });
    return () => subscription.remove();
  }, [selecting]);

  return (
    <View style={s.root} testID="recall-screen">
      <View style={[s.header, { paddingTop: insets.top + 12 }]}>
        <View style={s.titleRow}>
          <PageTitle>{t().recall.title}</PageTitle>
          {selecting ? (
            <View style={s.headerLinks}>
              <Muted style={s.selectedCount} testID="share-selected-count">
                {t().share.selectedCount(selected.length)}
              </Muted>
              <Pressable
                testID="share-select-cancel"
                accessibilityRole="button"
                accessibilityLabel={t().share.selectCancel}
                hitSlop={LINK_HIT_SLOP}
                onPress={() => setSelection(null)}
              >
                <Text style={s.shareLink}>{t().share.selectCancel}</Text>
              </Pressable>
            </View>
          ) : tab === 'timeline' && canShare ? (
            <View style={s.headerLinks}>
              {moments.length > 0 ? (
                <Pressable
                  testID="share-select"
                  accessibilityRole="button"
                  accessibilityLabel={t().share.selectA11y}
                  hitSlop={LINK_HIT_SLOP}
                  onPress={() => setSelection([])}
                >
                  <Text style={s.shareLink}>{t().share.selectLink}</Text>
                </Pressable>
              ) : null}
              <Pressable
                testID="share-timeline"
                accessibilityRole="button"
                accessibilityLabel={t().share.shareTimelineA11y}
                hitSlop={LINK_HIT_SLOP}
                onPress={() =>
                  sheet.open(t().share.timelineSheetTitle, () => <ShareTimelineSheet />)
                }
              >
                <Text style={s.shareLink}>{t().share.shareTimelineLink}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        <View style={s.tabs}>
          {tabs().map((t) => {
            const on = tab === t.key;
            return (
              <Pressable
                key={t.key}
                testID={`recall-tab-${t.key}`}
                accessibilityRole="tab"
                accessibilityLabel={t.label}
                accessibilityState={{ selected: on }}
                onPress={() => {
                  setTab(t.key);
                  setSelection(null);
                }}
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
        {tab === 'timeline' ? (
          <Timeline
            birthAt={birthAt}
            canShare={canShare}
            selected={selecting ? selected : null}
            onToggle={toggle}
            onStartSelect={(id) => setSelection([id])}
          />
        ) : null}
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
      {selecting ? (
        // 拇指够得到的底部：选好就点，不用回到页面顶上找按钮。
        <View style={s.selectBar}>
          <Button
            testID="share-selected"
            tone="dark"
            label={
              selected.length > 0
                ? t().share.shareSelected(selected.length)
                : t().share.shareSelectedNone
            }
            disabled={selected.length === 0}
            onPress={() => {
              const ids = selected;
              sheet.open(t().share.momentsSheetTitle, () => (
                <ShareMomentsSheet ids={ids} onCreated={() => setSelection(null)} />
              ));
            }}
          />
        </View>
      ) : canWrite ? (
        <PressScale
          testID="recall-fab"
          accessibilityLabel={tab === 'letters' ? t().recall.writeLetter : t().ui.recordMoment}
          style={s.fab}
          onPress={() => {
            const letter = tab === 'letters';
            sheet.open(letter ? t().recall.letterToBaby : t().ui.recordMoment, () => (
              <MomentSheet
                initialKind={letter ? 'letter' : 'moment'}
                initialMilestone={tab === 'milestones'}
                onSaved={showSaved}
              />
            ));
          }}
        >
          <Text style={s.fabLabel}>
            {tab === 'letters' ? t().recall.addLetter : t().recall.addMoment}
          </Text>
        </PressScale>
      ) : null}
    </View>
  );
}

function Timeline({
  birthAt,
  canShare,
  selected,
  onToggle,
  onStartSelect,
}: {
  birthAt: number;
  canShare: boolean;
  /** 选择模式里选中的回忆，不在选时是 null。 */
  selected: readonly string[] | null;
  onToggle: (id: string) => void;
  onStartSelect: (id: string) => void;
}) {
  const { moments } = useRecords();
  const router = useRouter();
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const { width } = useWindowDimensions();
  const confirmDelete = useDeleteConfirm();
  const favorites = useFavorites();
  if (moments.length === 0) {
    return <Empty title={t().recall.emptyTitle} sub={t().recall.emptySub} />;
  }
  const canDelete = app.role !== 'viewer';
  const openActions = (m: (typeof moments)[number]) =>
    sheet.open(m.data.title || t().ui.thisMoment, () => (
      <>
        <Button
          testID="moment-edit"
          tone="outline"
          label={t().records.edit}
          onPress={() =>
            sheet.replace(t().recall.editMoment, () => (
              <MomentSheet editMoment={{ id: m.id, data: m.data }} />
            ))
          }
        />
        <Button
          testID="moment-folders"
          tone="outline"
          label={t().library.addToFolder}
          onPress={() =>
            sheet.replace(t().library.addToFolder, () => (
              <FolderPicker target="moment" targetId={m.id} />
            ))
          }
        />
        {canShare ? (
          <>
            <Button
              testID="moment-share"
              tone="outline"
              label={t().share.shareMoment}
              onPress={() =>
                sheet.replace(t().share.momentsSheetTitle, () => <ShareMomentsSheet ids={[m.id]} />)
              }
            />
            <Button
              testID="moment-select"
              tone="outline"
              label={t().share.selectMoments}
              onPress={() => {
                sheet.close();
                onStartSelect(m.id);
              }}
            />
          </>
        ) : null}
        <Button
          testID="moment-delete"
          tone="ghost"
          label={t().recall.deleteMoment}
          onPress={() =>
            confirmDelete({ kind: 'moment', title: m.data.title }, () => {
              void app.remove(m.id);
              sheet.close();
              toast(t().recall.momentDeleted, {
                undo: () => void app.write('moment', m.data, m.id),
              });
            })
          }
        />
      </>
    ));
  return (
    <View style={s.timeline}>
      {moments.map((m) => {
        const audios = m.data.media.filter((x) => x.kind === 'audio');
        const found = momentCover(m.data.media, m.data.coverMediaId);
        const cover = found?.media;
        const fileNames = downloadFileNames(m.data.media, {
          title: m.data.title || t().ui.thisMoment,
          at: m.data.at,
        });
        const name = m.data.title || t().ui.thisMoment;
        const isSelected = selected?.includes(m.id) ?? false;
        return (
          <View key={m.id} style={{ gap: 10 }} testID={`moment-${m.id}`}>
            <View style={s.momentHeadRow}>
              <Pressable
                testID={`moment-head-${m.id}`}
                style={s.momentHead}
                accessibilityRole="button"
                accessibilityLabel={name}
                onPress={selected ? () => onToggle(m.id) : undefined}
                onLongPress={canDelete && !selected ? () => openActions(m) : undefined}
              >
                <Text style={s.momentTitle}>{m.data.title || t().ui.thisMoment}</Text>
                <Mono style={s.momentMeta}>
                  {formatMonthDay(m.data.at)} · {dayLabel(birthAt, m.data.at)}
                </Mono>
                {m.data.milestone ? (
                  <View style={s.milestoneTag}>
                    <Text style={s.milestoneTagText}>{t().recall.milestoneTag}</Text>
                  </View>
                ) : null}
              </Pressable>
              {selected ? (
                <Pressable
                  testID={`moment-select-${m.id}`}
                  accessibilityRole="checkbox"
                  accessibilityLabel={t().share.selectToggleA11y(name)}
                  accessibilityState={{ checked: isSelected }}
                  hitSlop={{ top: 11, bottom: 11, left: 14, right: 14 }}
                  onPress={() => onToggle(m.id)}
                  style={s.checkBox}
                >
                  <View style={[s.check, isSelected ? s.checkOn : null]}>
                    {isSelected ? <Text style={s.checkMark}>✓</Text> : null}
                  </View>
                </Pressable>
              ) : canDelete ? (
                <View style={s.momentActions}>
                  <StarButton
                    testID={`moment-star-${m.id}`}
                    on={Boolean(favorites.find(m.id))}
                    title={name}
                    onPress={() => void favorites.toggle('moment', m.id)}
                  />
                  <Pressable
                    testID={`moment-more-${m.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={t().recall.moreActions(m.data.title || t().ui.thisMoment)}
                    hitSlop={{ top: 12, bottom: 12, left: 14, right: 14 }}
                    onPress={() => openActions(m)}
                  >
                    <Text style={s.momentMore}>⋯</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
            {found && cover ? (
              <Pressable
                testID={`moment-cover-${m.id}`}
                accessibilityRole="imagebutton"
                accessibilityLabel={
                  cover.kind === 'video' ? t().recall.playVideo : t().recall.viewPhoto
                }
                onPress={() =>
                  selected
                    ? onToggle(m.id)
                    : router.push({
                        pathname: '/viewer',
                        params: { moment: m.id, index: found.index },
                      })
                }
                style={[s.cover, isSelected ? s.coverSelected : null]}
              >
                <MediaImage
                  media={cover}
                  variant="thumb"
                  width={width}
                  style={StyleSheet.absoluteFill}
                />
                {cover.kind === 'video' ? <PlayBadge /> : null}
                {found.count > 1 ? (
                  <View style={s.morePill}>
                    <Text style={{ fontSize: 11, color: colors.ink }}>
                      {t().recall.itemsTotal(found.count)}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            ) : null}
            {audios.map((a) => (
              <AudioCard key={a.id} media={a} fileName={fileNames.get(a.id) ?? t().ui.recording} />
            ))}
            {m.data.text ? <Serif>{m.data.text}</Serif> : null}
            {m.data.byName ? (
              <Muted style={{ fontSize: 11 }}>{t().recall.by(m.data.byName)}</Muted>
            ) : null}
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
      cells: visualMedia(m.data.media),
    }))
    .filter((g) => g.cells.length > 0);
  if (groups.length === 0) {
    return <Empty title={t().recall.noPhotos} sub={t().recall.noPhotosSub} />;
  }
  return (
    <View style={s.photos}>
      {groups.map(({ moment, cells }) => (
        <View key={moment.id} style={{ gap: 8 }}>
          <View style={s.groupHead}>
            <Text style={s.groupTitle} numberOfLines={1}>
              {moment.data.title || t().ui.thisMoment} · {formatMonthDay(moment.data.at)}
            </Text>
            <Muted>{t().recall.itemsCount(cells.length)}</Muted>
          </View>
          <View style={s.grid}>
            {cells.map((cell: MediaRef, index) => (
              <Pressable
                key={cell.id}
                testID={`photo-${cell.id}`}
                accessibilityRole="imagebutton"
                accessibilityLabel={
                  cell.kind === 'video' ? t().recall.playVideo : t().recall.viewPhoto
                }
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
  const pending = milestoneTemplates.filter(
    (item) => !done.some((m) => item.matches(m.data.title)),
  );
  return (
    <View style={s.milestones}>
      {done.map((m) => (
        <Pressable
          key={m.id}
          testID={`milestone-done-${m.id}`}
          accessibilityRole="button"
          accessibilityLabel={t().recall.viewNamed(m.data.title)}
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
            <Text style={{ fontSize: 14, color: colors.ink }}>
              {m.data.title || t().ui.thisMoment}
            </Text>
            <Muted style={{ fontSize: 11 }}>
              {formatMonthDay(m.data.at)} · {dayLabel(birthAt, m.data.at)}
            </Muted>
          </View>
          <Text style={s.milestoneAction}>{t().recall.view}</Text>
        </Pressable>
      ))}
      {pending.map((item) => (
        <Pressable
          key={item.id}
          testID={`milestone-${item.id}`}
          accessibilityRole="button"
          accessibilityLabel={t().recall.recordNamed(item.title)}
          disabled={role === 'viewer'}
          onPress={() =>
            sheet.open(t().ui.recordMoment, () => (
              <MomentSheet
                initialKind="moment"
                initialMilestone
                initialTitle={item.title}
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
            <Text style={{ fontSize: 14, color: colors.muted }}>{item.title}</Text>
            <Muted style={{ fontSize: 11 }}>{item.typical}</Muted>
          </View>
          {role === 'viewer' ? null : <Text style={s.milestoneAction}>{t().records.record}</Text>}
        </Pressable>
      ))}
      <Muted style={{ marginTop: 14, fontSize: 11, lineHeight: 18 }}>
        {t().recall.milestonesNote}
      </Muted>
    </View>
  );
}

function Letters() {
  const { letters } = useRecords();
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const confirmDelete = useDeleteConfirm();
  if (letters.length === 0) {
    return <Empty title={t().recall.noLetters} sub={t().recall.noLettersSub} />;
  }
  const canWrite = app.role !== 'viewer';
  const openActions = (l: (typeof letters)[number]) =>
    sheet.open(l.data.title || t().ui.untitled, () => (
      <>
        <Button
          testID="letter-edit"
          tone="outline"
          label={t().records.edit}
          onPress={() =>
            sheet.replace(t().recall.editLetter, () => (
              <MomentSheet editLetter={{ id: l.id, data: l.data }} />
            ))
          }
        />
        <Button
          testID="letter-delete"
          tone="ghost"
          label={t().recall.deleteLetter}
          onPress={() =>
            confirmDelete({ kind: 'letter', title: l.data.title }, () => {
              void app.remove(l.id);
              sheet.close();
              toast(t().recall.letterDeleted, {
                undo: () => void app.write('letter', l.data, l.id),
              });
            })
          }
        />
      </>
    ));
  return (
    <View style={s.letters}>
      {letters.map((l) => (
        <View key={l.id} style={s.letter} testID={`letter-${l.id}`}>
          <View style={s.letterHead}>
            <Text style={s.letterTitle}>{l.data.title || t().ui.untitled}</Text>
            <Mono style={{ fontSize: 11, color: colors.muted }}>{formatMonthDay(l.data.at)}</Mono>
            {canWrite ? (
              <Pressable
                testID={`letter-more-${l.id}`}
                accessibilityRole="button"
                accessibilityLabel={t().recall.moreActions(l.data.title || t().ui.untitled)}
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
          {l.data.byName ? (
            <Muted style={{ fontSize: 11 }}>{t().recall.by(l.data.byName)}</Muted>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  // zIndex：子标签的点击区伸到了头部下方，要压过后面的滚动区。
  header: { paddingHorizontal: spacing.page, gap: 12, zIndex: 1 },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  shareLink: { fontSize: 13, color: colors.accent },
  headerLinks: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  selectedCount: { fontSize: 13 },
  checkBox: { paddingTop: 3 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.off,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.green, borderColor: colors.green },
  checkMark: { fontSize: 13, lineHeight: 15, color: colors.card },
  coverSelected: { borderWidth: 2, borderColor: colors.green },
  selectBar: { position: 'absolute', left: spacing.page, right: spacing.page, bottom: 16 },
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
  momentActions: { flexDirection: 'row', alignItems: 'center', marginTop: -7 },
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
