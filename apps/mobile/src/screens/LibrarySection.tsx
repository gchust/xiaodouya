import { favoriteFolderCounts, favoriteItems, t } from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useRecords } from '../lib/app';
import { openResourceSheet } from '../sheets/librarySheets';
import { colors, themedStyles } from '../theme';
import { useSheet } from '../ui/overlays';
import { ListCard, Muted, Row, SectionTitle } from '../ui/primitives';
import { ResourceRow } from '../ui/ResourceRow';

/** 资料页上只放最近的几条，全部在育儿资料页。 */
const PREVIEW = 3;
/** 收藏夹在资料页上最多列几个，再多的在收藏页的胶囊里。 */
const FOLDER_ROWS = 4;
/** 链接文字只有 16 高，上下各扩 14 才到 44。 */
const LINK_HIT_SLOP = { top: 14, bottom: 14, left: 12, right: 12 };

/**
 * 资料页上的育儿资料和收藏（issue #98）。放在资料页而不是今天页：不是半夜要点的东西，
 * 不能挤占快捷记录。只看回忆的家人没有资料页。
 */
export function LibrarySection() {
  const router = useRouter();
  const sheet = useSheet();
  const { resources, favorites, favoriteFolders, moments } = useRecords();
  const items = favoriteItems({
    favorites,
    resourceIds: new Set(resources.map((r) => r.id)),
    momentIds: new Set(moments.map((m) => m.id)),
  });
  const counts = favoriteFolderCounts(items, new Set(favoriteFolders.map((f) => f.id)));
  const folders = favoriteFolders.slice(0, FOLDER_ROWS);

  return (
    <>
      <View testID="library-section" style={s.section}>
        <View style={s.sectionHead}>
          <SectionTitle>{t().library.title}</SectionTitle>
          <Pressable
            testID="library-add"
            accessibilityRole="button"
            accessibilityLabel={t().library.addA11y}
            hitSlop={LINK_HIT_SLOP}
            onPress={() => openResourceSheet(sheet)}
          >
            <Text style={s.link}>{t().library.addLink}</Text>
          </Pressable>
        </View>
        {resources.length === 0 ? (
          <Muted testID="library-empty" style={s.empty}>
            {t().library.empty}
          </Muted>
        ) : (
          <>
            <ListCard>
              {resources.slice(0, PREVIEW).map((entry, i, list) => (
                <ResourceRow
                  key={entry.id}
                  entry={entry}
                  index={i}
                  last={i === list.length - 1}
                  testPrefix="library"
                />
              ))}
            </ListCard>
            <Pressable
              testID="library-all"
              accessibilityRole="button"
              accessibilityLabel={t().library.seeAllA11y(resources.length)}
              hitSlop={LINK_HIT_SLOP}
              onPress={() => router.push('/resources')}
              style={s.allLink}
            >
              <Text style={s.linkMuted}>{t().library.seeAll(resources.length)}</Text>
            </Pressable>
          </>
        )}
      </View>

      <View testID="favorites-section" style={s.section}>
        <SectionTitle>{t().library.favorites}</SectionTitle>
        {items.length === 0 && favoriteFolders.length === 0 ? (
          <Muted testID="favorites-section-empty" style={s.empty}>
            {t().library.favoritesEmpty}
          </Muted>
        ) : (
          <ListCard>
            <Row
              testID="favorites-entry"
              label={t().library.allFavorites}
              accessibilityLabel={t().library.favoritesOpenA11y(items.length)}
              onPress={() => router.push('/favorites')}
              value={<Value text={t().library.favoritesCount(items.length)} />}
              last={folders.length === 0}
            />
            {folders.map((folder, i) => (
              <Row
                key={folder.id}
                testID={`favorites-entry-folder-${i}`}
                label={folder.data.name}
                accessibilityLabel={t().library.folderChipA11y(
                  folder.data.name,
                  counts.get(folder.id) ?? 0,
                )}
                onPress={() =>
                  router.push({ pathname: '/favorites', params: { folder: folder.id } })
                }
                value={<Value text={t().library.favoritesCount(counts.get(folder.id) ?? 0)} />}
                last={i === folders.length - 1}
              />
            ))}
          </ListCard>
        )}
      </View>
    </>
  );
}

function Value({ text }: { text: string }) {
  return (
    <View style={s.value}>
      <Text style={s.valueText}>{text}</Text>
      <Text style={s.chevron}>›</Text>
    </View>
  );
}

const s = themedStyles(() => ({
  section: { gap: 10 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  link: { fontSize: 12, color: colors.accentText },
  linkMuted: { fontSize: 12, color: colors.muted },
  allLink: { alignSelf: 'flex-end', paddingVertical: 2 },
  empty: { fontSize: 13, lineHeight: 20 },
  value: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  valueText: { fontSize: 13, color: colors.ink },
  chevron: { fontSize: 16, color: colors.muted },
}));
