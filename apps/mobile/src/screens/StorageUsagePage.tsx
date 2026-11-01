import { formatBytes, quotaStatus, type StorageUsage } from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../lib/app';
import { colors, spacing } from '../theme';
import { Button, ListCard, Muted, PageTitle, SectionTitle, Toggle } from '../ui/primitives';

/**
 * 平台托管存储时的“存储”页：只有用了多少、还剩多少，没有任何需要用户懂的东西。
 * 用自己存储的家庭没有上限，这里只显示已用。
 */
export function StorageUsagePage() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const app = useApp();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setUsage(await app.api.storageUsage());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '读取失败');
    }
  }, [app.api]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = usage ? quotaStatus(usage) : null;
  const limited = status !== null && status.level !== 'none';
  // 有上限时按上限算比例，这样一眼能看出还剩多少；没有上限时按总量。
  const base = usage ? (limited ? (usage.quota ?? 1) : Math.max(usage.total, 1)) : 1;
  const width = (value: number) =>
    `${value > 0 ? Math.min(100, Math.max(1, (value / base) * 100)) : 0}%` as `${number}%`;
  const warnColor = status?.level === 'full' ? colors.danger : colors.accent;

  return (
    <View style={s.root} testID="storage-screen">
      <ScrollView
        contentContainerStyle={[
          s.content,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 32 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: 8 }}>
          <Pressable
            testID="storage-back"
            accessibilityRole="button"
            accessibilityLabel="返回家人"
            hitSlop={12}
            onPress={() => router.back()}
          >
            <Text style={s.back}>‹ 家人</Text>
          </Pressable>
          <PageTitle>存储</PageTitle>
        </View>

        {loadError ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: colors.danger, fontSize: 13 }}>{loadError}</Text>
            <Button
              testID="storage-retry"
              tone="outline"
              label="重新读取"
              height={44}
              style={{ borderRadius: 14 }}
              labelStyle={s.outlineLabel}
              onPress={() => void load()}
            />
          </View>
        ) : null}
        {!usage && !loadError ? <ActivityIndicator color={colors.accent} /> : null}

        {usage ? (
          <View style={s.card} testID="storage-usage">
            <Text testID="storage-usage-total" style={s.total}>
              {limited
                ? `已用 ${formatBytes(usage.quotaUsed ?? usage.total)}，共 ${formatBytes(usage.quota ?? 0)}`
                : `已用 ${formatBytes(usage.total)}`}
            </Text>
            <View style={s.bar}>
              <View style={{ width: width(usage.image), backgroundColor: colors.accent }} />
              <View style={{ width: width(usage.video), backgroundColor: colors.sleep }} />
              <View style={{ width: width(usage.audio), backgroundColor: colors.diaper }} />
              <View style={{ width: width(usage.document), backgroundColor: colors.green }} />
            </View>
            <View style={s.legend}>
              <LegendItem color={colors.accent} label="照片" value={usage.image} />
              <LegendItem color={colors.sleep} label="视频" value={usage.video} />
              <LegendItem color={colors.diaper} label="录音" value={usage.audio} />
              <LegendItem color={colors.green} label="证件" value={usage.document} />
            </View>
            {status?.warning ? (
              <Text testID="storage-quota-warning" style={[s.warning, { color: warnColor }]}>
                {status.warning}
              </Text>
            ) : null}
          </View>
        ) : null}

        {usage ? (
          <Muted style={s.note}>
            {limited ? '照片、视频和证件都存在小豆芽的服务器上，不用自己设置什么。\n' : ''}
            {usage.trash > 0
              ? `刚删除的内容（${formatBytes(usage.trash)}）会再保留 ${usage.trashDays} 天，之后彻底清理，这期间不算在已用空间里。`
              : `删除回忆或证件后，空间马上就能用，文件会再保留 ${usage.trashDays} 天才彻底清理。`}
          </Muted>
        ) : null}

        <View style={{ gap: 8 }}>
          <SectionTitle>选项</SectionTitle>
          <ListCard>
            <Toggle
              testID="pref-wifi"
              label="视频只在 Wi-Fi 下上传"
              sub="用流量时先排队，连上 Wi-Fi 自动继续"
              value={app.prefs.videoWifiOnly}
              onChange={(v) => void app.updatePrefs({ videoWifiOnly: v })}
              last
            />
          </ListCard>
        </View>
      </ScrollView>
    </View>
  );
}

function LegendItem({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <View style={s.legendItem}>
      <View style={[s.swatch, { backgroundColor: color }]} />
      <Muted style={{ fontSize: 11 }}>
        {label} {formatBytes(value)}
      </Muted>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, gap: 20 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  outlineLabel: { fontSize: 15, fontWeight: '400' },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  total: { fontSize: 15, fontWeight: '500', color: colors.ink },
  bar: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: '#efe7dc',
  },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 7, height: 7, borderRadius: 4 },
  warning: { fontSize: 12, lineHeight: 18 },
  note: { fontSize: 11, lineHeight: 18 },
});
