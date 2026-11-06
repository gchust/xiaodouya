import {
  dayLabel,
  favoriteFolderCounts,
  favoriteItems,
  formatMonthDay,
  type MomentData,
  momentCover,
  t,
} from '@xiaodouya/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRecords } from '../lib/app';
import { useFavorites } from '../lib/library';
import { MediaImage } from '../lib/mediaViews';
import { FolderEditSheet, FolderPicker, NewFolderSheet } from '../sheets/librarySheets';
import { colors, spacing, themedStyles } from '../theme';
import { useSheet } from '../ui/overlays';
import { Button, Chip, ListCard, Muted, PageTitle, Serif, Stripes } from '../ui/primitives';
import { ResourceRow, StarButton } from '../ui/ResourceRow';

/**
 * 收藏：回忆和育儿资料放在一起，新收藏的在前。上面一排是收藏夹，一项可以在几个收藏夹里。
 * 收藏和收藏夹全家共用；只看回忆的家人没有资料页，也就到不了这里（服务端也不下发）。
 */
export function FavoritesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sheet = useSheet();
  const params = useLocalSearchParams<{ folder?: string }>();
  const { favorites, favoriteFolders, moments, resources, baby } = useRecords();
  const [folderId, setFolderId] = useState<string | null>(params.folder ?? null);
  const liveFolderIds = new Set(favoriteFolders.map((f) => f.id));
  // 家人在别的手机上删了这个收藏夹：回到全部。
  const activeFolder = folderId ? favoriteFolders.find((f) => f.id === folderId) : undefined;
  const base = {
    favorites,
    resourceIds: new Set(resources.map((r) => r.id)),
    momentIds: new Set(moments.map((m) => m.id)),
  };
  const all = favoriteItems(base);
  const counts = favoriteFolderCounts(all, liveFolderIds);
  const items = activeFolder ? favoriteItems({ ...base, folderId: activeFolder.id }) : all;
  const birthAt = baby?.data.birthAt ?? 0;

  return (
    <ScrollView
      testID="favorites-screen"
      style={s.root}
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ gap: 6, alignItems: 'flex-start' }}>
        <Pressable
          testID="favorites-back"
          accessibilityRole="button"
          accessibilityLabel={t().info.backToInfo}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={s.back}>{t().info.backInfoLink}</Text>
        </Pressable>
        <View style={s.titleRow}>
          <PageTitle>{t().library.favorites}</PageTitle>
          {activeFolder ? (
            <Pressable
              testID="favorites-manage"
              accessibilityRole="button"
              accessibilityLabel={t().library.folderActionsA11y(activeFolder.data.name)}
              hitSlop={12}
              onPress={() =>
                sheet.open(activeFolder.data.name, () => (
                  <FolderEditSheet folder={activeFolder} onDeleted={() => setFolderId(null)} />
                ))
              }
            >
              <Text style={s.link}>{t().library.manageFolder}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={s.chips}>
        <Chip
          testID="favorites-folder-all"
          label={t().library.allChip(all.length)}
          selected={!activeFolder}
          onPress={() => setFolderId(null)}
        />
        {favoriteFolders.map((folder, i) => (
          <Chip
            key={folder.id}
            testID={`favorites-folder-${i}`}
            label={t().library.folderChip(folder.data.name, counts.get(folder.id) ?? 0)}
            selected={activeFolder?.id === folder.id}
            onPress={() => setFolderId(folder.id)}
          />
        ))}
        <Pressable
          testID="favorites-folder-new"
          accessibilityRole="button"
          accessibilityLabel={t().library.newFolderTitle}
          hitSlop={{ top: 7, bottom: 7, left: 4, right: 4 }}
          onPress={() =>
            sheet.open(t().library.newFolderTitle, () => (
              <NewFolderSheet onCreated={(id) => setFolderId(id)} />
            ))
          }
          style={s.newChip}
        >
          <Text style={s.newChipLabel}>{t().library.newFolder}</Text>
        </Pressable>
      </View>

      {items.length === 0 ? (
        <Muted testID="favorites-empty" style={s.emptyText}>
          {activeFolder
            ? t().library.folderEmpty
            : all.length === 0
              ? t().library.favoritesEmpty
              : t().library.favoritesNone}
        </Muted>
      ) : (
        <ListCard>
          {items.map((item, i) => {
            const last = i === items.length - 1;
            if (item.target === 'resource') {
              const entry = resources.find((r) => r.id === item.targetId);
              return entry ? (
                <ResourceRow
                  key={item.favoriteId}
                  entry={entry}
                  index={i}
                  last={last}
                  testPrefix="fav"
                />
              ) : null;
            }
            const moment = moments.find((m) => m.id === item.targetId);
            return moment ? (
              <MomentRow
                key={item.favoriteId}
                moment={moment}
                index={i}
                last={last}
                birthAt={birthAt}
              />
            ) : null;
          })}
        </ListCard>
      )}

      <Muted testID="favorites-footer" style={s.note}>
        {t().library.favoritesFooter}
      </Muted>
    </ScrollView>
  );
}

function MomentRow({
  moment,
  index,
  last,
  birthAt,
}: {
  moment: { id: string; data: MomentData };
  index: number;
  last: boolean;
  birthAt: number;
}) {
  const sheet = useSheet();
  const { toggle } = useFavorites();
  const { data } = moment;
  const title = data.title || t().ui.thisMoment;
  const cover = momentCover(data.media, data.coverMediaId);
  const meta = [t().library.momentTag, formatMonthDay(data.at), dayLabel(birthAt, data.at)].join(
    ' · ',
  );
  const open = () => sheet.open(title, () => <MomentPreview moment={moment} />);
  return (
    <View style={[s.row, last ? null : s.divider]}>
      <Pressable
        testID={`fav-row-${index}`}
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={open}
        style={s.main}
      >
        {cover ? (
          <MediaImage media={cover.media} variant="thumb" style={s.thumb} />
        ) : (
          <Stripes style={s.thumb} />
        )}
        <View style={{ flex: 1, gap: 2 }}>
          <Text testID={`fav-row-${index}-title`} style={s.title} numberOfLines={2}>
            {title}
          </Text>
          <Muted style={{ fontSize: 11 }} numberOfLines={1}>
            {meta}
          </Muted>
        </View>
      </Pressable>
      <StarButton
        testID={`fav-star-${index}`}
        on
        title={title}
        onPress={() => void toggle('moment', moment.id)}
      />
      <Pressable
        testID={`fav-more-${index}`}
        accessibilityRole="button"
        accessibilityLabel={t().library.moreA11y(title)}
        hitSlop={{ top: 12, bottom: 12, left: 6, right: 10 }}
        onPress={open}
        style={s.more}
      >
        <Text style={s.moreGlyph}>⋯</Text>
      </Pressable>
    </View>
  );
}

/** 收藏里点开一条回忆：正文和照片入口，以及取消收藏、放进收藏夹。 */
function MomentPreview({ moment }: { moment: { id: string; data: MomentData } }) {
  const sheet = useSheet();
  const router = useRouter();
  const { find, toggle } = useFavorites();
  const { data } = moment;
  const cover = momentCover(data.media, data.coverMediaId);
  const favorited = Boolean(find(moment.id));
  return (
    <>
      <Muted style={{ fontSize: 12 }}>{formatMonthDay(data.at)}</Muted>
      {data.text ? <Serif testID="fav-moment-text">{data.text}</Serif> : null}
      {data.byName ? <Muted style={{ fontSize: 11 }}>{t().recall.by(data.byName)}</Muted> : null}
      {cover ? (
        <Button
          testID="fav-moment-media"
          tone="dark"
          label={t().library.viewMedia}
          onPress={() => {
            sheet.close();
            router.push({ pathname: '/viewer', params: { moment: moment.id, index: cover.index } });
          }}
        />
      ) : null}
      <Button
        testID="fav-moment-folders"
        tone="outline"
        label={t().library.addToFolder}
        onPress={() =>
          sheet.replace(t().library.addToFolder, () => (
            <FolderPicker target="moment" targetId={moment.id} />
          ))
        }
      />
      <Button
        testID="fav-moment-favorite"
        tone="outline"
        label={favorited ? t().library.unfavorite : t().library.favorite}
        onPress={() => {
          sheet.close();
          void toggle('moment', moment.id);
        }}
      />
    </>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, gap: 16 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  titleRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  link: { fontSize: 13, color: colors.accentText },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  newChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.dashed,
    borderStyle: 'dashed',
  },
  newChipLabel: { fontSize: 12, color: colors.muted },
  emptyText: { fontSize: 13, lineHeight: 21 },
  note: { fontSize: 11, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 10 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  thumb: { width: 48, height: 48, borderRadius: 10, overflow: 'hidden' },
  title: { fontSize: 14, color: colors.ink, lineHeight: 20 },
  more: { width: 28, height: 40, alignItems: 'center', justifyContent: 'center' },
  moreGlyph: { fontSize: 18, color: colors.muted },
}));
