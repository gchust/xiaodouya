import { ageText, nextBabyCreatedAt, regionFor, t } from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Entry } from '../data/store';
import { useApp, useRecordsOf } from '../lib/app';
import { MediaImage } from '../lib/mediaViews';
import { colors, themedStyles } from '../theme';
import { BirthPicker } from '../ui/BirthPicker';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Field, Muted, Stripes } from '../ui/primitives';
import { RegionPicker } from '../ui/RegionPicker';

/**
 * 多个宝宝（issue #106）：今天页头像上的切换器和加宝宝。只有一个宝宝时头像照旧是看头像、换头像，
 * 这里的切换器不出现；加宝宝的入口在资料页出生档案的标题旁。
 */

/**
 * 服务端能不能管住多个宝宝（`/v1/config` 的 `multiBaby`，F-164）。自己部署的旧服务端不挡旧版 App，
 * 加了第二个宝宝，还没升级的家人手机上第一个宝宝就会被换掉，所以问不到（离线、旧服务端）时不让加。
 */
export function useServerMultiBaby(): boolean {
  const app = useApp();
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    app.api
      .publicConfig()
      .then((config) => {
        if (live) setSupported(config.multiBaby === true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [app.api]);
  return supported;
}

/** 能不能加宝宝：服务端支持、能写记录的家人。只看回忆的家人没有资料页，也就没有入口。 */
export function useCanAddBaby(): boolean {
  const { role } = useApp();
  const supported = useServerMultiBaby();
  return supported && role !== null && role !== 'viewer';
}

function BabyAvatar({ baby, size }: { baby: Entry<'baby'>; size: number }) {
  const avatar = baby.data.avatar;
  return (
    <View style={[s.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      {avatar ? (
        <MediaImage media={avatar} variant="thumb" style={StyleSheet.absoluteFill} />
      ) : (
        <Stripes style={StyleSheet.absoluteFill} />
      )}
    </View>
  );
}

/** 选宝宝。点一行就换，下面是当前宝宝的头像和加宝宝。 */
export function BabySwitcherSheet({
  onAvatar,
  canChangeAvatar,
}: {
  /** 看或换当前宝宝的头像，和只有一个宝宝时点头像一样。 */
  onAvatar: () => void;
  canChangeAvatar: boolean;
}) {
  const app = useApp();
  const canAdd = useCanAddBaby();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const babies = useRecordsOf('babies');
  const current = useRecordsOf('baby');
  const now = Date.now();
  if (!current) return null;
  const hasAvatar = Boolean(current.data.avatar);

  return (
    <>
      <View style={s.list} testID="baby-switch-list">
        {babies.map((baby, index) => {
          const selected = baby.id === current.id;
          return (
            <Pressable
              key={baby.id}
              testID={`baby-switch-${index}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={t().babies.pickA11y(baby.data.name)}
              style={[s.row, index < babies.length - 1 && s.divider]}
              onPress={() => {
                sheet.close();
                if (selected) return;
                void app.store.setCurrentBaby(baby.id);
                toast(t().babies.switched(baby.data.name));
              }}
            >
              <BabyAvatar baby={baby} size={36} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.name} numberOfLines={1}>
                  {baby.data.name}
                </Text>
                <Muted style={{ fontSize: 12 }}>{ageText(baby.data.birthAt, now)}</Muted>
              </View>
              {selected ? <Text style={s.current}>{t().babies.current}</Text> : null}
            </Pressable>
          );
        })}
      </View>
      <Muted style={{ fontSize: 12, lineHeight: 19 }}>{t().babies.switchNote}</Muted>
      {hasAvatar || canChangeAvatar ? (
        <Button
          testID="baby-switch-avatar"
          tone="outline"
          height={44}
          label={
            hasAvatar
              ? t().babies.viewAvatar(current.data.name)
              : t().babies.addAvatar(current.data.name)
          }
          onPress={() => {
            sheet.close();
            onAvatar();
          }}
        />
      ) : null}
      {canAdd ? (
        <Button
          testID="baby-switch-add"
          tone="ghost"
          height={44}
          label={t().babies.addTitle}
          onPress={() => sheet.open(t().babies.addTitle, () => <AddBabySheet />)}
        />
      ) : null}
    </>
  );
}

/**
 * 加宝宝。`createdAt` 取“现在”和“已有最大的加 1”中较大的（`nextBabyCreatedAt`），id 是新的，
 * 不能用家庭 id（那是第一个宝宝的）。地区默认用当前宝宝的，只有管理员能选：服务端会把其他家人
 * 新建档案的地区换成家庭的地区（第一个宝宝的），这里就直接写那个，免得同步后变来变去。
 */
export function AddBabySheet() {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const current = useRecordsOf('baby');
  const babies = useRecordsOf('babies');
  const isAdmin = app.role === 'admin';
  const familyRegion = regionFor(babies[0]?.data.region).id;
  const [name, setName] = useState('');
  const [birth, setBirth] = useState(() => {
    const d = new Date();
    d.setSeconds(0, 0);
    return d;
  });
  const [region, setRegion] = useState(() =>
    isAdmin ? regionFor(current?.data.region).id : familyRegion,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    if (birth.getTime() > Date.now()) return setError(t().auth.birthInFuture);
    setError(null);
    setSaving(true);
    try {
      const id = Crypto.randomUUID();
      await app.write(
        'baby',
        {
          name: trimmed,
          birthAt: birth.getTime(),
          region: isAdmin ? region : familyRegion,
          createdAt: nextBabyCreatedAt(app.store.babyRefs(), Date.now()),
        },
        id,
      );
      await app.store.setCurrentBaby(id);
      sheet.close();
      toast(t().babies.added(trimmed));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Muted style={{ fontSize: 13, lineHeight: 21 }}>{t().babies.addIntro}</Muted>
      {/* 加了删不掉，旧版 App 也会被服务端挡住（issue #106），加之前要说清楚。 */}
      <View testID="add-baby-warning" style={s.tip}>
        <Text style={s.tipText}>{t().babies.addWarning}</Text>
      </View>
      <Field
        testID="add-baby-name"
        label={t().auth.babyName}
        placeholder={t().auth.babyNamePlaceholder}
        value={name}
        onChangeText={setName}
        maxLength={40}
      />
      <BirthPicker value={birth} onChange={setBirth} />
      {isAdmin ? (
        <View style={{ gap: 5 }}>
          <Muted style={{ fontSize: 12 }}>{t().babies.regionThisBaby}</Muted>
          <RegionPicker value={region} onChange={setRegion} />
          <Muted style={{ fontSize: 11, lineHeight: 18 }}>{t().babies.regionHint}</Muted>
        </View>
      ) : (
        <Muted testID="add-baby-region-note" style={{ fontSize: 12, lineHeight: 19 }}>
          {t().babies.regionByAdmin(regionFor(familyRegion).name)}
        </Muted>
      )}
      {error ? <Text style={s.error}>{error}</Text> : null}
      <Button
        testID="add-baby-submit"
        tone="dark"
        label={t().babies.addSubmit}
        disabled={!name.trim() || saving}
        onPress={() => void submit()}
      />
    </>
  );
}

const s = themedStyles(() => ({
  list: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingVertical: 10 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  avatar: { overflow: 'hidden', backgroundColor: colors.sand },
  name: { fontSize: 15, color: colors.ink },
  current: { fontSize: 12, color: colors.greenText },
  error: { fontSize: 13, color: colors.dangerText },
  tip: {
    backgroundColor: colors.sand,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  tipText: { fontSize: 13, lineHeight: 21, color: colors.inkSoft },
}));
