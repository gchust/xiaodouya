import { type ResourceSource, resourceSource, resourceSources, t } from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRecords } from '../lib/app';
import { openResourceSheet } from '../sheets/librarySheets';
import { colors, spacing } from '../theme';
import { useSheet } from '../ui/overlays';
import { Chip, ListCard, Muted, PageTitle } from '../ui/primitives';
import { ResourceRow } from '../ui/ResourceRow';

/** 全部育儿资料，按来源筛选。只列出这家人存过的来源，只有一种时不显示筛选。 */
export function ResourcesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sheet = useSheet();
  const { resources } = useRecords();
  const [filter, setFilter] = useState<ResourceSource | null>(null);
  const present = resourceSources.filter((source) =>
    resources.some((r) => resourceSource(r.data.url) === source),
  );
  const shown = filter ? resources.filter((r) => resourceSource(r.data.url) === filter) : resources;

  return (
    <ScrollView
      testID="resources-screen"
      style={s.root}
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ gap: 6, alignItems: 'flex-start' }}>
        <Pressable
          testID="resources-back"
          accessibilityRole="button"
          accessibilityLabel={t().info.backToInfo}
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Text style={s.back}>{t().info.backInfoLink}</Text>
        </Pressable>
        <View style={s.titleRow}>
          <PageTitle>{t().library.title}</PageTitle>
          <Pressable
            testID="resources-add"
            accessibilityRole="button"
            accessibilityLabel={t().library.addA11y}
            hitSlop={12}
            onPress={() => openResourceSheet(sheet)}
          >
            <Text style={s.link}>{t().library.addLink}</Text>
          </Pressable>
        </View>
      </View>

      {present.length > 1 ? (
        <View style={s.chips}>
          <Chip
            testID="resources-filter-all"
            label={t().library.all}
            selected={filter === null}
            onPress={() => setFilter(null)}
          />
          {present.map((source) => (
            <Chip
              key={source}
              testID={`resources-filter-${source}`}
              label={t().library.sources[source]}
              selected={filter === source}
              onPress={() => setFilter(filter === source ? null : source)}
            />
          ))}
        </View>
      ) : null}

      {shown.length === 0 ? (
        <Muted testID="resources-empty" style={s.note}>
          {t().library.empty}
        </Muted>
      ) : (
        <ListCard>
          {shown.map((entry, i) => (
            <ResourceRow
              key={entry.id}
              entry={entry}
              index={i}
              last={i === shown.length - 1}
              testPrefix="resources"
            />
          ))}
        </ListCard>
      )}

      <Muted testID="resources-footer" style={s.note}>
        {t().library.footer}
      </Muted>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, gap: 16 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  titleRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  link: { fontSize: 13, color: colors.accent },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { fontSize: 11, lineHeight: 18 },
});
