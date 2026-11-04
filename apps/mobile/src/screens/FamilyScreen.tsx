import {
  type Dimension,
  type FamilyMember,
  type Locale,
  lengthUnits,
  type Role,
  regionFor,
  roleLabels,
  scaleFor,
  t,
  temperatureUnits,
  type UnitPrefs,
  unitsSummary,
  volumeUnits,
  weightUnits,
} from '@xiaodouya/shared';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useNow, useRecords, useUnits, useUploadProgress } from '../lib/app';
import {
  currentAppVersion,
  getUpdateController,
  useUpdatePhase,
  useUpdateSettings,
} from '../lib/appUpdateRuntime';
import { exportGrowthBook } from '../lib/book';
import { formatLastSeen } from '../lib/dates';
import { exportFamilyData } from '../lib/familyExport';
import { ensureNotificationPermission } from '../lib/notifications';
import { canOpenStorage, storageSummaryText } from '../lib/storagePage';
import { useTabScrollRef } from '../lib/tabScroll';
import { SharedLinksSheet, useCanShare } from '../sheets/shareSheets';
import { UpdateSheet, updateRowSub } from '../sheets/updateSheet';
import { colors, fonts, spacing } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import {
  Button,
  Chip,
  ListCard,
  Mono,
  Muted,
  PageTitle,
  SectionTitle,
  SoftInput,
  Toggle,
} from '../ui/primitives';
import { DeleteAccountSheet, VerifyEmailSheet } from './AccountPanels';

export function FamilyScreen() {
  const insets = useSafeAreaInsets();
  const scrollRef = useTabScrollRef('family');
  const app = useApp();
  const { moments, letters, baby, pendingCount } = useRecords();
  const uploadProgress = useUploadProgress();
  const units = useUnits();
  const pendingFiles = uploadProgress.total + uploadProgress.failedCount;
  const sheet = useSheet();
  const showShares = useCanShare();
  const router = useRouter();
  const { toast } = useFeedback();
  const now = useNow(60_000);
  const [storageSummary, setStorageSummary] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportingData, setExportingData] = useState(false);
  const { me, role, prefs } = app;
  const isAdmin = role === 'admin';
  const canRecord = role !== 'viewer';
  const showStorage = canOpenStorage(role);
  // 只有打开了应用内更新的 Android 构建才有这一行。
  const updates = getUpdateController(app.api, app.db);
  const updatePhase = useUpdatePhase(updates);
  const updateSettings = useUpdateSettings(updates);
  const appVersion = currentAppVersion();

  const loadStorage = useCallback(async () => {
    if (!showStorage) return;
    try {
      // 存储配置只有管理员能读。
      const [config, usage] = await Promise.all([
        isAdmin ? app.api.getStorage() : null,
        app.api.storageUsage(),
      ]);
      setStorageSummary(storageSummaryText(usage, config));
    } catch {
      setStorageSummary(t().family.cantRead);
    }
  }, [app.api, isAdmin, showStorage]);

  // 问不到（离线）时是 null，按可用显示：反馈页可以先写，草稿会留着。
  const [feedbackOn, setFeedbackOn] = useState<boolean | null>(null);
  useEffect(() => {
    app.api
      .publicConfig()
      .then((config) => setFeedbackOn(config.feedback?.enabled === true))
      .catch(() => setFeedbackOn(null));
  }, [app.api]);

  // 底部标签切走后页面不会卸载，只读一次的话，传完文件回来用量还是旧的。
  useFocusEffect(
    useCallback(() => {
      void loadStorage();
      void app.refreshMe();
    }, [loadStorage, app.refreshMe]),
  );

  const signOut = () => {
    const unsynced = pendingCount > 0 || pendingFiles > 0;
    sheet.open(t().auth.signOut, () => (
      <>
        <Muted style={{ fontSize: 13, lineHeight: 21 }}>
          {unsynced
            ? t().family.pendingWarn(
                pendingCount ? t().family.pendingRecords(pendingCount) : '',
                pendingCount && pendingFiles ? t().family.pendingAnd : '',
                pendingFiles ? t().family.pendingFiles(pendingFiles) : '',
              )
            : t().family.signOutNote}
        </Muted>
        <Button
          testID="signout-confirm"
          tone={unsynced ? 'outline' : 'accent'}
          label={unsynced ? t().family.signOutAnyway : t().auth.signOut}
          onPress={() => {
            sheet.close();
            void app.signOut();
          }}
        />
      </>
    ));
  };

  const cancelInvite = (invite: { id: string; label: string }) => {
    sheet.open(t().family.cancelInviteQ(invite.label), () => (
      <>
        <Muted style={{ fontSize: 13, lineHeight: 21 }}>{t().family.cancelInviteNote}</Muted>
        <Button
          testID="invite-cancel-confirm"
          label={t().family.confirmCancelInvite}
          onPress={() => {
            sheet.close();
            void app.api
              .deleteInvite(invite.id)
              .then(() => app.refreshMe())
              .catch((e: Error) => toast(e.message));
          }}
        />
      </>
    ));
  };

  return (
    <ScrollView
      ref={scrollRef}
      testID="family-screen"
      style={s.scroll}
      contentContainerStyle={[s.content, { paddingTop: insets.top + 12 }]}
      showsVerticalScrollIndicator={false}
    >
      <PageTitle>{t().family.title}</PageTitle>

      <ListCard>
        {(me?.members ?? []).map((m, i, all) => (
          <MemberRow
            key={m.userId}
            member={m}
            isMe={m.userId === me?.user.id}
            now={now}
            last={i === all.length - 1 && !isAdmin}
            onPress={
              isAdmin && m.userId !== me?.user.id
                ? () => sheet.open(m.label, () => <MemberSheet member={m} />)
                : undefined
            }
          />
        ))}
        {(me?.invites ?? []).map((invite) => (
          <View key={invite.id} style={[s.memberRow, s.divider]} testID={`invite-${invite.label}`}>
            <View style={s.avatar}>
              <Text style={s.avatarText}>{invite.label.slice(0, 1)}</Text>
            </View>
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={{ fontSize: 14, color: colors.ink }}>{invite.label}</Text>
              <Muted style={{ fontSize: 11 }}>
                {t().family.inviteSent(roleLabels[invite.role])}
              </Muted>
            </View>
            <Pressable
              testID={`invite-cancel-${invite.label}`}
              accessibilityRole="button"
              accessibilityLabel={t().family.cancelInviteA11y(invite.label)}
              hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
              onPress={() => cancelInvite(invite)}
            >
              <Text style={{ fontSize: 11, color: colors.accent }}>{t().common.cancel}</Text>
            </Pressable>
          </View>
        ))}
        {isAdmin ? (
          <Pressable
            testID="invite-open"
            accessibilityRole="button"
            accessibilityLabel={t().family.inviteA11y}
            style={{ paddingVertical: 12 }}
            onPress={() => sheet.open(t().family.inviteA11y, () => <InviteSheet />)}
          >
            <Text style={{ fontSize: 13, color: colors.accent }}>{t().family.inviteLink}</Text>
          </Pressable>
        ) : null}
      </ListCard>

      {canRecord ? (
        <View style={s.section}>
          <SectionTitle>{t().family.reminders}</SectionTitle>
          <ListCard>
            <Toggle
              testID="pref-feed"
              label={t().family.feedReminder}
              sub={t().family.feedReminderSub}
              value={prefs.feedReminder}
              onChange={(v) => {
                void app.updatePrefs({ feedReminder: v });
                if (v) void ensureNotificationPermission();
              }}
              last
            />
          </ListCard>
        </View>
      ) : null}

      <View style={s.section}>
        <SectionTitle>{t().family.settings}</SectionTitle>
        <ListCard>
          {pendingFiles > 0 ? (
            // 卡片可以关掉，关掉之后这里还能找到上传详情。
            <NavRow
              testID="open-uploads"
              label={t().ui.uploadsTitle}
              sub={t().family.pendingFiles(pendingFiles).trim()}
              onPress={() => router.push('/uploads')}
            />
          ) : null}
          {showStorage ? (
            <NavRow
              testID="open-storage"
              label={t().family.storage}
              sub={storageSummary || t().family.loading}
              onPress={() => router.push('/storage')}
            />
          ) : null}
          {canRecord ? (
            <Toggle
              testID="pref-doc-lock"
              label={t().family.docLock}
              sub={t().family.docLockSub}
              value={prefs.documentLock}
              onChange={(v) => void app.updatePrefs({ documentLock: v })}
            />
          ) : null}
          {canRecord && Platform.OS === 'android' ? (
            <NavRow
              testID="open-widgets"
              label={t().widgetUi.galleryRow}
              sub={t().widgetUi.galleryRowSub}
              onPress={() => router.push('/widgets')}
            />
          ) : null}
          <NavRow
            testID="open-units"
            label={t().family.units}
            sub={unitsSummary(units)}
            onPress={() => sheet.open(t().family.units, () => <UnitsSheet />)}
          />
          <NavRow
            testID="open-language"
            label={t().family.language}
            sub={languageSummary(prefs.locale)}
            onPress={() => sheet.open(t().family.language, () => <LanguageSheet />)}
          />
          {showShares ? (
            <NavRow
              testID="open-shares"
              label={t().share.linksRow}
              sub={t().share.linksRowSub}
              onPress={() => sheet.open(t().share.linksRow, () => <SharedLinksSheet />)}
            />
          ) : null}
          <NavRow
            testID="export-book"
            label={exporting ? t().family.bookBusy : t().family.exportBook}
            sub={t().family.exportBookSub}
            onPress={() => {
              if (exporting || !baby) return;
              setExporting(true);
              exportGrowthBook(app.api, baby.data, moments, letters)
                .catch((e: Error) => toast(e.message || t().family.bookFailed))
                .finally(() => setExporting(false));
            }}
          />
          <NavRow
            testID="export-data"
            label={exportingData ? t().account.exportRowBusy : t().account.exportRow}
            sub={t().account.exportRowSub}
            onPress={() => {
              if (exportingData) return;
              setExportingData(true);
              exportFamilyData(app.api)
                .catch((e: Error) => toast(e.message || t().account.exportFailed))
                .finally(() => setExportingData(false));
            }}
          />
          {me?.emailVerified === false ? (
            <NavRow
              testID="verify-email"
              label={t().account.verifyRow}
              sub={t().account.verifyRowSub}
              onPress={() => sheet.open(t().account.verifyTitle, () => <VerifyEmailSheet />)}
            />
          ) : null}
          {updates && appVersion ? (
            <NavRow
              testID="check-update"
              label={t().update.row}
              sub={updateRowSub(updatePhase, appVersion.name)}
              onPress={() => sheet.open(t().update.title, () => <UpdateSheet />)}
            />
          ) : null}
          {/* 存在这台手机上，不同步：流量和存储是这台手机的。默认关，见 shared 的 defaultAutoUpdatePrefs。 */}
          {updates && appVersion && updateSettings ? (
            <Toggle
              testID="pref-auto-update"
              label={t().update.autoRow}
              sub={t().update.autoRowSub}
              value={updateSettings.autoDownload}
              onChange={(v) => void updates.setAutoDownload(v)}
            />
          ) : null}
          {updates && appVersion && updateSettings?.autoDownload ? (
            <Toggle
              testID="pref-auto-update-wifi"
              label={t().update.wifiOnlyRow}
              sub={t().update.wifiOnlySub}
              value={updateSettings.wifiOnly}
              onChange={(v) => void updates.setWifiOnly(v)}
            />
          ) : null}
          {/* 没开反馈的服务器也显示这一行，写明暂不可用：藏起来的话用户会以为 App 没有这个功能。 */}
          <NavRow
            testID="open-feedback"
            label={t().feedback.row}
            sub={feedbackOn === false ? t().feedback.rowUnavailable : t().feedback.rowSub}
            onPress={() => router.push('/feedback')}
          />
          {/* 只是入口：服务端每次请求都按 FEEDBACK_VIEWER_EMAILS 判断，App 拿不到名单。 */}
          {me?.canViewFeedback === true ? (
            <NavRow
              testID="open-feedback-inbox"
              label={t().feedback.inboxRow}
              sub={t().feedback.inboxRowSub}
              onPress={() => router.push('/feedback-inbox')}
            />
          ) : null}
          <NavRow
            testID="sign-out"
            label={t().auth.signOut}
            sub={me?.user.email ?? ''}
            onPress={signOut}
            last
          />
        </ListCard>
        <ListCard>
          <NavRow
            testID="delete-account"
            label={t().account.deleteRow}
            sub={t().account.deleteRowSub}
            onPress={() => sheet.open(t().account.deleteTitle, () => <DeleteAccountSheet />)}
            last
          />
        </ListCard>
        <Muted style={{ fontSize: 11, textAlign: 'center', marginTop: 8 }}>
          {t().family.versionLine(app.serverUrl)}
        </Muted>
      </View>
    </ScrollView>
  );
}

function NavRow({
  label,
  sub,
  onPress,
  last,
  testID,
}: {
  label: string;
  sub?: string;
  onPress: () => void;
  last?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[s.navRow, last ? null : s.divider]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 14, color: colors.ink }}>{label}</Text>
        {sub ? (
          <Muted style={{ fontSize: 11 }} numberOfLines={1}>
            {sub}
          </Muted>
        ) : null}
      </View>
      <Text style={{ fontSize: 16, color: colors.muted }}>›</Text>
    </Pressable>
  );
}

function MemberRow({
  member,
  isMe,
  now,
  last,
  onPress,
}: {
  member: FamilyMember;
  isMe: boolean;
  now: number;
  last: boolean;
  onPress?: () => void;
}) {
  const seen = formatLastSeen(member.lastSeenAt, now);
  return (
    <Pressable
      testID={`member-${member.label}`}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={member.label}
      disabled={!onPress}
      onPress={onPress}
      style={[s.memberRow, last ? null : s.divider]}
    >
      <View style={s.avatar}>
        <Text style={s.avatarText}>{member.label.slice(0, 1)}</Text>
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ fontSize: 14, color: colors.ink }}>{member.label}</Text>
        <Muted style={{ fontSize: 11 }}>{roleLabels[member.role]}</Muted>
      </View>
      <Text style={{ fontSize: 11, color: isMe || seen.online ? colors.green : colors.muted }}>
        {isMe ? t().family.me : seen.text}
      </Text>
    </Pressable>
  );
}

const unitRows = (): { dimension: Dimension; label: string; options: readonly string[] }[] => [
  { dimension: 'volume', label: t().family.unitVolume, options: volumeUnits },
  { dimension: 'temperature', label: t().family.unitTemp, options: temperatureUnits },
  { dimension: 'weight', label: t().family.unitWeight, options: weightUnits },
  { dimension: 'length', label: t().family.unitLength, options: lengthUnits },
];

/** 单位是每个人自己的：爸爸看 oz、妈妈看 ml 都行，记录里存的都是公制。 */
function UnitsSheet() {
  const app = useApp();
  const { baby } = useRecords();
  const units = useUnits();
  const regionName = regionFor(baby?.data.region).name;
  return (
    <>
      {unitRows().map(({ dimension, label, options }) => (
        <View key={dimension} style={s.unitRow}>
          <Text style={{ fontSize: 14, color: colors.ink }}>{label}</Text>
          <View style={s.chips}>
            {options.map((unit) => (
              <Chip
                key={unit}
                testID={`unit-${dimension}-${unit}`}
                label={scaleFor(dimension, unit).label}
                selected={units[dimension] === unit}
                onPress={() =>
                  void app.updatePrefs({
                    units: { ...app.prefs.units, [dimension]: unit } as UnitPrefs,
                  })
                }
              />
            ))}
          </View>
        </View>
      ))}
      <Muted style={{ fontSize: 12, lineHeight: 19 }}>{t().family.unitsNote}</Muted>
      <Button
        testID="units-reset"
        tone="ghost"
        label={t().family.resetUnits(regionName)}
        disabled={!app.prefs.units}
        onPress={() => void app.updatePrefs({ units: undefined })}
      />
    </>
  );
}

function languageSummary(preference: Locale | undefined): string {
  if (!preference) return t().family.languageSystem;
  return preference === 'zh' ? t().family.languageZh : t().family.languageEn;
}

/**
 * 选好后 AppProvider 换语言并重新挂载界面，弹层也随之关闭。
 * “中文”和“English”在两种语言下都写自己的文字，看不懂当前语言的人也认得出来。
 */
function LanguageSheet() {
  const app = useApp();
  const current = app.prefs.locale;
  const options: { id: string; value: Locale | undefined; label: string }[] = [
    { id: 'system', value: undefined, label: t().family.languageSystem },
    { id: 'zh', value: 'zh', label: t().family.languageZh },
    { id: 'en', value: 'en', label: t().family.languageEn },
  ];
  return (
    <>
      <View style={s.chips}>
        {options.map((option) => (
          <Chip
            key={option.id}
            testID={`lang-${option.id}`}
            label={option.label}
            selected={current === option.value}
            onPress={() => void app.updatePrefs({ locale: option.value })}
          />
        ))}
      </View>
      <Muted style={{ fontSize: 12, lineHeight: 19 }}>{t().family.languageNote}</Muted>
    </>
  );
}

const roleOptions = (): { role: Role; hint: string }[] => [
  { role: 'caregiver', hint: t().family.caregiverHint },
  { role: 'viewer', hint: t().family.viewerHint },
  { role: 'admin', hint: t().family.adminHint },
];

function RolePicker({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <View style={{ gap: 8 }}>
      {roleOptions().map((o) => {
        const on = value === o.role;
        return (
          <Pressable
            key={o.role}
            testID={`role-${o.role}`}
            accessibilityRole="button"
            accessibilityLabel={roleLabels[o.role]}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.role)}
            style={[s.roleOption, { backgroundColor: on ? colors.ink : colors.paper }]}
          >
            <Text style={{ fontSize: 14, color: on ? colors.paper : colors.ink }}>
              {roleLabels[o.role]}
            </Text>
            <Text style={{ fontSize: 11, color: on ? '#bdb3a8' : colors.muted }}>{o.hint}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function InviteSheet() {
  const app = useApp();
  const { toast } = useFeedback();
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<Role>('caregiver');
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const invite = await app.api.createInvite(role, label.trim());
      setCode(invite.code);
      await app.refreshMe();
    } catch (error) {
      toast(error instanceof Error ? error.message : t().family.inviteFailed);
    } finally {
      setBusy(false);
    }
  };

  if (code) {
    const formatted = `${code.slice(0, 4)} ${code.slice(4)}`;
    return (
      <>
        <Muted style={{ fontSize: 13, lineHeight: 21 }}>{t().family.inviteSendTo(label)}</Muted>
        <View style={s.codeBox}>
          <Mono weight="medium" style={s.code} testID="invite-code" selectable>
            {formatted}
          </Mono>
        </View>
        <Button
          testID="invite-share"
          label={t().family.sendToFamily}
          onPress={() =>
            void Share.share({
              message: t().family.inviteShare(app.serverUrl, formatted),
            })
          }
        />
      </>
    );
  }

  return (
    <>
      <View style={s.chips}>
        {t().family.labelSuggestions.map((v) => (
          <Chip
            key={v}
            testID={`label-${v}`}
            label={v}
            selected={label === v}
            onPress={() => setLabel(v)}
          />
        ))}
      </View>
      <SoftInput
        testID="invite-label"
        value={label}
        onChangeText={setLabel}
        placeholder={t().family.calledPlaceholder}
        maxLength={40}
      />
      <RolePicker value={role} onChange={setRole} />
      <Button
        testID="invite-create"
        label={t().family.createInvite}
        disabled={!label.trim()}
        busy={busy}
        onPress={() => void create()}
      />
    </>
  );
}

function MemberSheet({ member }: { member: FamilyMember }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const [role, setRole] = useState<Role>(member.role);
  const [confirming, setConfirming] = useState(false);
  const run = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action();
      await app.refreshMe();
      sheet.close();
      toast(message);
    } catch (error) {
      toast(error instanceof Error ? error.message : t().family.actionFailed);
    }
  };
  return (
    <>
      <RolePicker value={role} onChange={setRole} />
      <Button
        testID="member-save"
        label={t().common.save}
        disabled={role === member.role}
        onPress={() =>
          void run(() => app.api.updateMember(member.userId, { role }), t().family.updated)
        }
      />
      <Button
        testID="member-remove"
        tone="ghost"
        label={confirming ? t().family.removeQ(member.label) : t().family.removeMember}
        onPress={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          void run(() => app.api.removeMember(member.userId), t().family.removed(member.label));
        }}
      />
    </>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: spacing.page, paddingBottom: 28, gap: 24 },
  section: { gap: 8 },
  memberRow: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 12 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.sand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontFamily: fonts.serifBold, fontSize: 14, color: colors.ink },
  navRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  unitRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  roleOption: { paddingHorizontal: 14, paddingVertical: 11, borderRadius: 12, gap: 2 },
  codeBox: {
    backgroundColor: colors.paper,
    borderRadius: 14,
    paddingVertical: 22,
    alignItems: 'center',
  },
  code: { fontSize: 30, letterSpacing: 2 },
});
