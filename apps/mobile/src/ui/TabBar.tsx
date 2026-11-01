import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';

/** 原型的底部导航：没有图标，只有文字和激活时的赤陶色短条。 */
export function TabBar({ state, descriptors, emitter, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const visible = state.routes.filter((route) => {
    const options = descriptors[route.key]?.options;
    return (options as { href?: string | null } | undefined)?.href !== null;
  });
  return (
    <View style={[s.bar, { paddingBottom: Math.max(insets.bottom, 8) + 6 }]}>
      {visible.map((route) => {
        const focused = state.routes[state.index]?.key === route.key;
        const title = descriptors[route.key]?.options.title ?? route.name;
        return (
          <Pressable
            key={route.key}
            testID={`tab-${route.name}`}
            accessibilityRole="tab"
            accessibilityLabel={title}
            accessibilityState={{ selected: focused }}
            style={s.tab}
            onPress={() => {
              const event = emitter.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) navigateToTab(route.key);
            }}
          >
            <View
              style={[s.indicator, { backgroundColor: focused ? colors.accent : 'transparent' }]}
            />
            <Text
              style={{
                fontSize: 12,
                color: focused ? colors.ink : colors.muted,
                fontWeight: focused ? '700' : '400',
              }}
            >
              {title}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    paddingTop: 4,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.paper,
  },
  tab: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 8 },
  indicator: { width: 18, height: 3, borderRadius: 2 },
});
