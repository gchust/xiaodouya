import { documentKind, t } from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useApp, useRecords } from '../lib/app';
import { gridItemWidth } from '../lib/layout';
import { DocAddSheet, readersText } from '../sheets/documentSheets';
import { colors, spacing, themedStyles } from '../theme';
import { DocumentCard } from '../ui/DocumentCard';
import { useSheet } from '../ui/overlays';
import { Muted, SectionTitle } from '../ui/primitives';

const GAP = 8;
const LINK_HIT_SLOP = { top: 14, bottom: 14, left: 12, right: 12 };

/**
 * 家人页的“家人的证件”（F-137，issue #89）：自己的证件在前，后面是家人选了给我看的。
 * 只看回忆的家人读不到证件，整组不显示。服务端只发我能看的，所以这里不用再判断能不能看。
 */
export function FamilyDocumentsSection() {
  const app = useApp();
  const router = useRouter();
  const sheet = useSheet();
  const { documents } = useRecords();
  const { width } = useWindowDimensions();
  // 旧服务端不按 owner 过滤，新建的私人证件会发给全家。问不到时（离线）已经有自己的证件就说明服务端支持。
  const [serverSupports, setServerSupports] = useState<boolean | null>(null);
  useEffect(() => {
    app.api
      .publicConfig()
      .then((config) => setServerSupports(config.personalDocuments === true))
      .catch(() => setServerSupports(null));
  }, [app.api]);
  const userId = app.me?.user.id ?? null;
  const members = app.me?.members ?? [];
  if (!userId) return null;
  const cardWidth = gridItemWidth(width - spacing.page * 2, 2, GAP);
  const mine = documents.filter((d) => documentKind(d.data, userId) === 'mine');
  const shared = documents.filter((d) => documentKind(d.data, userId) === 'shared');
  // 离开了家庭的人的证件服务端不会发来；手机上还没同步到删除标记时，按称呼找不到就不显示。
  const ownerLabel = (owner: string | undefined) =>
    members.find((m) => m.userId === owner)?.label ?? null;
  const visibleShared = shared.filter((d) => ownerLabel(d.data.owner) !== null);
  const canAdd = serverSupports === true || mine.length > 0;
  if (!canAdd && visibleShared.length === 0) return null;
  const open = (id: string) =>
    router.push({ pathname: '/doc/[id]', params: { id, from: 'family' } });

  return (
    <View style={s.section} testID="family-docs">
      <View style={s.head}>
        <SectionTitle>{t().info.familyDocs}</SectionTitle>
        {canAdd ? (
          <Pressable
            testID="my-doc-add"
            accessibilityRole="button"
            accessibilityLabel={t().info.addMyDocA11y}
            hitSlop={LINK_HIT_SLOP}
            onPress={() => sheet.open(t().info.addMyDoc, () => <DocAddSheet owner={userId} />)}
          >
            <Text style={s.link}>{t().nutritionUi.addLink}</Text>
          </Pressable>
        ) : null}
      </View>
      {mine.length === 0 && visibleShared.length === 0 ? (
        <Muted style={{ fontSize: 13, lineHeight: 20 }}>{t().info.familyDocsEmpty}</Muted>
      ) : (
        <View style={s.grid}>
          {mine.map((d) => (
            <DocumentCard
              key={d.id}
              data={d.data}
              width={cardWidth}
              locked={app.prefs.documentLock}
              footer={readersText(d.data, userId, members)}
              onPress={() => open(d.id)}
            />
          ))}
          {visibleShared.map((d) => (
            <DocumentCard
              key={d.id}
              data={d.data}
              width={cardWidth}
              locked={app.prefs.documentLock}
              footer={t().info.ownerDoc(ownerLabel(d.data.owner) ?? '')}
              onPress={() => open(d.id)}
            />
          ))}
        </View>
      )}
      <Muted style={{ fontSize: 11 }}>{t().info.familyDocsNote}</Muted>
    </View>
  );
}

const s = themedStyles(() => ({
  section: { gap: 8 },
  // zIndex 让链接的热区压过下面紧挨着的卡片。
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    zIndex: 1,
  },
  link: { fontSize: 12, color: colors.accentText },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
}));
