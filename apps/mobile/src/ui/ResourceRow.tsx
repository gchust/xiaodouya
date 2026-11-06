import {
  formatMonthDay,
  type ResourceData,
  resourceSource,
  resourceSourceLabel,
  t,
} from '@xiaodouya/shared';
import { Pressable, Text, View } from 'react-native';
import { openResourceUrl, useFavorites } from '../lib/library';
import { ResourceActions } from '../sheets/librarySheets';
import { colors, themedStyles } from '../theme';
import { useFeedback, useSheet } from './overlays';
import { Muted } from './primitives';

/** ☆ 和 ★ 不在衬线和等宽的子集字体里，用系统字体画。 */
export function StarButton({
  on,
  title,
  onPress,
  testID,
}: {
  on: boolean;
  title: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={on ? t().library.unstarA11y(title) : t().library.starA11y(title)}
      accessibilityState={{ selected: on }}
      hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}
      onPress={onPress}
      style={s.star}
    >
      <Text style={[s.starGlyph, { color: on ? colors.accent : colors.muted }]}>
        {on ? '★' : '☆'}
      </Text>
    </Pressable>
  );
}

/**
 * 一条资料：左边是来源的文字小方块（不用平台的图标和颜色），标题、来源和日期、备注；
 * 右边收藏和 ⋯。点一行直接在 App 里打开原页面。
 */
export function ResourceRow({
  entry,
  index,
  last,
  testPrefix = 'resource',
}: {
  entry: { id: string; data: ResourceData };
  index: number;
  last: boolean;
  testPrefix?: string;
}) {
  const sheet = useSheet();
  const { toast } = useFeedback();
  const { find, toggle } = useFavorites();
  const { data } = entry;
  const source = resourceSource(data.url);
  const sourceName = resourceSourceLabel(source);
  const meta = [
    sourceName,
    formatMonthDay(data.addedAt),
    data.byName ? t().library.by(data.byName) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const favorited = Boolean(find(entry.id));
  return (
    <View style={[s.row, last ? null : s.divider]}>
      <Pressable
        testID={`${testPrefix}-row-${index}`}
        accessibilityRole="link"
        accessibilityLabel={t().library.openA11y(data.title, sourceName)}
        onPress={() => void openResourceUrl(data.url, toast)}
        onLongPress={() => sheet.open(data.title, () => <ResourceActions entry={entry} />)}
        style={s.main}
      >
        <View style={s.badge}>
          <Text style={s.badgeText} numberOfLines={1} adjustsFontSizeToFit>
            {t().library.badges[source]}
          </Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text testID={`${testPrefix}-row-${index}-title`} style={s.title} numberOfLines={2}>
            {data.title}
          </Text>
          <Muted style={{ fontSize: 11 }} numberOfLines={1}>
            {meta}
          </Muted>
          {data.note ? (
            <Muted style={{ fontSize: 12 }} numberOfLines={2}>
              {data.note}
            </Muted>
          ) : null}
        </View>
      </Pressable>
      <StarButton
        testID={`${testPrefix}-star-${index}`}
        on={favorited}
        title={data.title}
        onPress={() => void toggle('resource', entry.id)}
      />
      <Pressable
        testID={`${testPrefix}-more-${index}`}
        accessibilityRole="button"
        accessibilityLabel={t().library.moreA11y(data.title)}
        hitSlop={{ top: 12, bottom: 12, left: 6, right: 10 }}
        onPress={() => sheet.open(data.title, () => <ResourceActions entry={entry} />)}
        style={s.more}
      >
        <Text style={s.moreGlyph}>⋯</Text>
      </Pressable>
    </View>
  );
}

const s = themedStyles(() => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 10 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  badge: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: colors.sand,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { fontSize: 11, color: colors.inkSoft, fontWeight: '600' },
  title: { fontSize: 14, color: colors.ink, lineHeight: 20 },
  star: { width: 32, height: 40, alignItems: 'center', justifyContent: 'center' },
  starGlyph: { fontSize: 18 },
  more: { width: 28, height: 40, alignItems: 'center', justifyContent: 'center' },
  moreGlyph: { fontSize: 18, color: colors.muted },
}));
