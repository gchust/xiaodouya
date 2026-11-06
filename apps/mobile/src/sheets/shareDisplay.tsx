import {
  SHARE_NICKNAME_MAX,
  SHARE_TTL_DAYS,
  type ShareDisplay,
  type SharePrefs,
  type ShareTimelineDefault,
  type ShareTtlDays,
  sharePrefsOf,
  shareTimelineDefaults,
  t,
} from '@xiaodouya/shared';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useApp, useRecords } from '../lib/app';
import { nicknameProblem, shareDisplaySummary, shareDisplayUnsupported } from '../lib/share';
import { colors, themedStyles } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Field, Muted, SectionTitle, Toggle } from '../ui/primitives';

/**
 * 分享设置（F-141，issue #96）：对方看到的名字和头像、默认有效期、时间线默认范围。
 * 设置跟着账号（`Prefs.share`）；分享弹层从它开始，弹层上改的只用于这一次。
 */

/**
 * 服务端认不认识这些选项（`/v1/config` 的 `shareDisplay`）。旧服务端会悄悄丢掉它们，
 * 照样发真实名字。问不到（离线）时是 null。
 */
export function useShareDisplaySupported(): boolean | null {
  const app = useApp();
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    app.api
      .publicConfig()
      .then((config) => {
        if (live) setSupported(config.shareDisplay === true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [app.api]);
  return supported;
}

/** 这个账号的分享默认值。 */
export function useSharePrefs(): SharePrefs {
  return sharePrefsOf(useApp().prefs.share);
}

/** 显示名字、称呼、显示头像。设置页和分享弹层共用。 */
export function ShareDisplayFields({
  value,
  onChange,
}: {
  value: ShareDisplay;
  onChange: (next: ShareDisplay) => void;
}) {
  const { baby } = useRecords();
  const problem = nicknameProblem(value.nickname);
  return (
    <View style={s.fields}>
      <Toggle
        testID="share-show-name"
        label={t().share.showName}
        sub={value.showName ? undefined : t().share.showNameOffSub}
        value={value.showName}
        onChange={(showName) => onChange({ ...value, showName })}
        last={!value.showName}
      />
      {value.showName ? (
        <View style={s.nickname}>
          <Field
            testID="share-nickname"
            label={t().share.nickname}
            placeholder={t().share.nicknamePlaceholder}
            value={value.nickname}
            maxLength={SHARE_NICKNAME_MAX + 5}
            autoCorrect={false}
            returnKeyType="done"
            onChangeText={(nickname) => onChange({ ...value, nickname })}
          />
          {problem ? (
            <Text style={s.problem} testID="share-nickname-problem">
              {problem}
            </Text>
          ) : null}
        </View>
      ) : null}
      <Toggle
        testID="share-show-avatar"
        label={t().share.showAvatar}
        sub={baby?.data.avatar ? t().share.showAvatarSub : t().share.showAvatarNone}
        value={value.showAvatar}
        onChange={(showAvatar) => onChange({ ...value, showAvatar })}
        last
      />
      <Muted style={s.note}>{t().share.displayNote}</Muted>
    </View>
  );
}

/**
 * 分享弹层里建链接之前的一行：收起时是“对方看到：…”和 `修改`，点开就地改，只用于这一次。
 * 服务端不认识这些选项时不显示；这时改过默认值的人会看到提醒。
 */
export function ShareDisplayRow({
  value,
  onChange,
}: {
  value: ShareDisplay;
  onChange: (next: ShareDisplay) => void;
}) {
  const supported = useShareDisplaySupported();
  const [open, setOpen] = useState(false);
  if (shareDisplayUnsupported(value, supported)) {
    return (
      <View style={s.warning} testID="share-display-unsupported">
        <Text style={s.warningText}>{t().share.displayUnsupported}</Text>
      </View>
    );
  }
  if (supported !== true) return null;
  if (open) {
    return (
      <View style={s.openBox} testID="share-display-open">
        <SectionTitle>{t().share.displayTitle}</SectionTitle>
        <ShareDisplayFields value={value} onChange={onChange} />
      </View>
    );
  }
  return (
    <Pressable
      testID="share-display-edit"
      accessibilityRole="button"
      accessibilityLabel={t().share.displayEditA11y}
      onPress={() => setOpen(true)}
      style={s.summaryRow}
    >
      <Muted style={s.summary} testID="share-display-summary" numberOfLines={2}>
        {shareDisplaySummary(value)}
      </Muted>
      <Text style={s.edit}>{t().share.displayEdit}</Text>
    </Pressable>
  );
}

const TIMELINE_LABEL: Record<ShareTimelineDefault, () => string> = {
  week: () => t().share.timelineRangeWeek,
  month: () => t().share.timelineRangeMonth,
  all: () => t().share.timelineRangeAll,
};

/** 家人页设置里的“分享设置”。只影响以后新建的链接，已经发出去的按它们创建时的设置。 */
export function ShareSettingsSheet() {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const saved = useSharePrefs();
  const [ttlDays, setTtlDays] = useState<ShareTtlDays>(saved.ttlDays);
  const [timeline, setTimeline] = useState<ShareTimelineDefault>(saved.timeline);
  const [display, setDisplay] = useState<ShareDisplay>(saved.display);
  const problem = nicknameProblem(display.nickname);

  const save = async () => {
    if (problem) return;
    await app.updatePrefs({
      share: { ttlDays, timeline, display: { ...display, nickname: display.nickname.trim() } },
    });
    sheet.close();
    toast(t().share.settingsSaved);
  };

  return (
    <>
      <View style={s.section}>
        <SectionTitle>{t().share.settingsTtl}</SectionTitle>
        <View style={s.chips}>
          {SHARE_TTL_DAYS.map((days) => (
            <Chip
              key={days}
              testID={`share-default-ttl-${days}`}
              label={t().share.ttlDays(days)}
              selected={ttlDays === days}
              onPress={() => setTtlDays(days)}
            />
          ))}
        </View>
      </View>
      <View style={s.section}>
        <SectionTitle>{t().share.settingsTimeline}</SectionTitle>
        <View style={s.chips}>
          {shareTimelineDefaults.map((key) => (
            <Chip
              key={key}
              testID={`share-default-range-${key}`}
              label={TIMELINE_LABEL[key]()}
              selected={timeline === key}
              onPress={() => setTimeline(key)}
            />
          ))}
        </View>
      </View>
      <View style={s.section}>
        <SectionTitle>{t().share.displayTitle}</SectionTitle>
        <ShareDisplayFields value={display} onChange={setDisplay} />
      </View>
      <Muted style={s.note}>{t().share.settingsNote}</Muted>
      <Button
        testID="share-settings-save"
        label={t().share.settingsSave}
        disabled={Boolean(problem)}
        onPress={() => void save()}
      />
    </>
  );
}

const s = themedStyles(() => ({
  fields: { gap: 0 },
  nickname: { paddingVertical: 10, gap: 6 },
  problem: { fontSize: 12, lineHeight: 18, color: colors.dangerText },
  note: { fontSize: 12, lineHeight: 19 },
  section: { gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  openBox: { gap: 4 },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.paper,
  },
  summary: { flex: 1, fontSize: 13, lineHeight: 20 },
  edit: { fontSize: 13, color: colors.accentText },
  warning: { backgroundColor: colors.sand, borderRadius: 12, padding: 12, gap: 6 },
  warningText: { fontSize: 13, lineHeight: 20, color: colors.inkSoft },
}));
