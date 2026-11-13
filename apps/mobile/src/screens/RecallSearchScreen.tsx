import {
  dayLabel,
  formatClock,
  formatMonthDay,
  groupByDay,
  type LetterData,
  type MomentData,
  matchesSearch,
  momentCover,
  parseSearchQuery,
  searchSnippet,
  t,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useDeferredValue, useMemo, useState } from 'react';
import { Pressable, SectionList, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useRecords } from '../lib/app';
import { downloadFileNames } from '../lib/downloadCore';
import { AudioCard, MediaImage } from '../lib/mediaViews';
import { shareDayTitle } from '../lib/share';
import { MomentSheet } from '../sheets/MomentSheet';
import { colors, fonts, spacing, themedStyles } from '../theme';
import { useDeleteConfirm } from '../ui/DeleteConfirm';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Empty, Mono, Muted, PageTitle, Serif, Stripes } from '../ui/primitives';
import { Highlighted, SearchField } from '../ui/Search';

type Hit =
  | { kind: 'moment'; id: string; data: MomentData }
  | { kind: 'letter'; id: string; data: LetterData };

const fallbackTitle = (hit: Hit) =>
  hit.data.title || (hit.kind === 'moment' ? t().ui.thisMoment : t().ui.untitled);

/**
 * 搜回忆和信（issue #109）。单独一页，不放进回忆页的时间线里：结果要把回忆和信按天放在一起，
 * 回忆页的四个子标签各管各的。点开一条能看全文、照片和录音，能写的家人还能改、能删。
 */
export function RecallSearchScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { baby, moments, letters } = useRecords();
  const sheet = useSheet();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const terms = useMemo(() => parseSearchQuery(deferredQuery), [deferredQuery]);
  const birthAt = baby?.data.birthAt ?? 0;
  const now = Date.now();

  const hits = useMemo(() => {
    if (terms.length === 0) return [];
    const all: Hit[] = [
      ...moments.map((m) => ({ kind: 'moment' as const, id: m.id, data: m.data })),
      ...letters.map((l) => ({ kind: 'letter' as const, id: l.id, data: l.data })),
    ];
    return all.filter((hit) => matchesSearch([hit.data.title, hit.data.text], terms));
  }, [moments, letters, terms]);
  const sections = useMemo(
    () =>
      groupByDay(hits, (hit) => hit.data.at).map((day) => ({
        ...day,
        key: String(day.dayStart),
      })),
    [hits],
  );
  const searching = terms.length > 0;

  const open = (hit: Hit) =>
    sheet.open(fallbackTitle(hit), () => <HitSheet hit={hit} terms={terms} birthAt={birthAt} />);

  return (
    <View style={s.root} testID="recall-search-screen">
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          testID="recall-search-back"
          accessibilityRole="button"
          accessibilityLabel={t().search.backToRecall}
          hitSlop={12}
          onPress={() => router.back()}
          style={{ alignSelf: 'flex-start' }}
        >
          <Text style={s.back}>{t().search.backRecallLink}</Text>
        </Pressable>
        <PageTitle>{t().search.recallTitle}</PageTitle>
        <SearchField
          testID="recall-search-input"
          value={query}
          onChangeText={setQuery}
          placeholder={t().search.recallPlaceholder}
          accessibilityLabel={t().search.recallA11y}
          autoFocus
        />
        {searching ? (
          <Muted style={s.count} testID="recall-search-count">
            {t().search.count(hits.length)}
          </Muted>
        ) : null}
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(hit) => hit.id}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        ListEmptyComponent={
          searching ? (
            <Empty title={t().search.empty(deferredQuery.trim())} sub={t().search.emptySub} />
          ) : (
            <Muted style={s.hint}>{t().search.recallHint}</Muted>
          )
        }
        renderSectionHeader={({ section }) => (
          <Text style={s.dayTitle}>{shareDayTitle(section.dayStart, now)}</Text>
        )}
        renderItem={({ item, index, section }) => (
          <HitRow
            hit={item}
            terms={terms}
            last={index === section.data.length - 1}
            onPress={() => open(item)}
          />
        )}
      />
    </View>
  );
}

function HitRow({
  hit,
  terms,
  last,
  onPress,
}: {
  hit: Hit;
  terms: readonly string[];
  last: boolean;
  onPress: () => void;
}) {
  const title = fallbackTitle(hit);
  const tag = hit.kind === 'moment' ? t().search.momentTag : t().search.letterTag;
  const cover = hit.kind === 'moment' ? momentCover(hit.data.media, hit.data.coverMediaId) : null;
  const snippet = hit.data.text ? searchSnippet(hit.data.text, terms) : '';
  return (
    <Pressable
      testID={`recall-search-hit-${hit.id}`}
      accessibilityRole="button"
      accessibilityLabel={t().search.openA11y(tag, title)}
      onPress={onPress}
      style={[s.row, last ? null : s.divider]}
    >
      {hit.kind === 'moment' ? (
        cover ? (
          <MediaImage media={cover.media} variant="thumb" style={s.thumb} />
        ) : (
          <Stripes style={s.thumb} />
        )
      ) : null}
      <View style={{ flex: 1, gap: 3 }}>
        <Muted style={s.meta}>
          {tag} · <Mono style={s.meta}>{formatClock(hit.data.at)}</Mono>
        </Muted>
        <Text style={s.title} numberOfLines={2}>
          <Highlighted text={title} terms={terms} hitStyle={s.titleHit} />
        </Text>
        {snippet ? (
          <Serif style={s.snippet} numberOfLines={3}>
            <Highlighted text={snippet} terms={terms} hitStyle={s.serifHit} />
          </Serif>
        ) : null}
      </View>
    </Pressable>
  );
}

/** 点开一条：日期、全文、照片和录音；能写的家人还能改、能删，和回忆页的 `⋯` 一样。 */
function HitSheet({
  hit,
  terms,
  birthAt,
}: {
  hit: Hit;
  terms: readonly string[];
  birthAt: number;
}) {
  const app = useApp();
  const router = useRouter();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const confirmDelete = useDeleteConfirm();
  const canWrite = app.role !== 'viewer';
  const { data } = hit;
  const meta = [formatMonthDay(data.at), formatClock(data.at)];
  if (hit.kind === 'moment') meta.push(dayLabel(birthAt, data.at));
  const moment = hit.kind === 'moment' ? hit.data : null;
  const cover = moment ? momentCover(moment.media, moment.coverMediaId) : null;
  const audios = moment ? moment.media.filter((m) => m.kind === 'audio') : [];
  const fileNames = moment
    ? downloadFileNames(moment.media, { title: fallbackTitle(hit), at: moment.at })
    : new Map<string, string>();

  const remove = () => {
    const done = () => {
      void app.remove(hit.id);
      sheet.close();
    };
    if (hit.kind === 'moment') {
      confirmDelete({ kind: 'moment', title: hit.data.title }, () => {
        done();
        toast(t().recall.momentDeleted, {
          undo: () => void app.write('moment', hit.data, hit.id),
        });
      });
    } else {
      confirmDelete({ kind: 'letter', title: hit.data.title }, () => {
        done();
        toast(t().recall.letterDeleted, {
          undo: () => void app.write('letter', hit.data, hit.id),
        });
      });
    }
  };

  return (
    <>
      <Mono style={s.sheetMeta}>{meta.join(' · ')}</Mono>
      {data.text ? (
        <Serif testID="recall-search-text">
          <Highlighted text={data.text} terms={terms} hitStyle={s.serifHit} />
        </Serif>
      ) : null}
      {data.byName ? <Muted style={{ fontSize: 11 }}>{t().recall.by(data.byName)}</Muted> : null}
      {audios.map((a) => (
        <AudioCard key={a.id} media={a} fileName={fileNames.get(a.id) ?? t().ui.recording} />
      ))}
      {cover ? (
        <Button
          testID="recall-search-media"
          tone="dark"
          label={t().library.viewMedia}
          onPress={() => {
            sheet.close();
            router.push({ pathname: '/viewer', params: { moment: hit.id, index: cover.index } });
          }}
        />
      ) : null}
      {canWrite ? (
        <>
          <Button
            testID="recall-search-edit"
            tone="outline"
            label={t().records.edit}
            onPress={() =>
              hit.kind === 'moment'
                ? sheet.replace(t().recall.editMoment, () => (
                    <MomentSheet editMoment={{ id: hit.id, data: hit.data }} />
                  ))
                : sheet.replace(t().recall.editLetter, () => (
                    <MomentSheet editLetter={{ id: hit.id, data: hit.data }} />
                  ))
            }
          />
          <Button
            testID="recall-search-delete"
            tone="ghost"
            label={hit.kind === 'moment' ? t().recall.deleteMoment : t().recall.deleteLetter}
            onPress={remove}
          />
        </>
      ) : null}
    </>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.paper },
  header: { paddingHorizontal: spacing.page, gap: 8, paddingBottom: 4 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  count: { marginTop: 2 },
  hint: { paddingHorizontal: spacing.page, paddingTop: 18, fontSize: 13, lineHeight: 21 },
  dayTitle: {
    marginTop: 18,
    marginBottom: 2,
    marginHorizontal: spacing.page,
    fontSize: 12,
    color: colors.muted,
    letterSpacing: 1,
  },
  row: {
    marginHorizontal: spacing.page,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
  },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  thumb: { width: 48, height: 48, borderRadius: 10, overflow: 'hidden', marginTop: 2 },
  meta: { fontSize: 11, color: colors.muted },
  title: { fontFamily: fonts.serifBold, fontSize: 15, lineHeight: 22, color: colors.ink },
  // 父级已经是粗体的字体文件，再写 fontWeight 会在 Android 上叠一层假粗体。
  titleHit: { color: colors.accentText, fontWeight: 'normal' },
  snippet: { fontSize: 13, lineHeight: 21, color: colors.inkSoft },
  serifHit: { fontFamily: fonts.serifBold, color: colors.accentText, fontWeight: 'normal' },
  sheetMeta: { fontSize: 12, color: colors.muted },
}));
