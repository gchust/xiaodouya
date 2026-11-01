import {
  type Dimension,
  type FamilyMember,
  formatBytes,
  lengthUnits,
  type Role,
  regionFor,
  roleLabels,
  scaleFor,
  storageProviderNames,
  temperatureUnits,
  type UnitPrefs,
  unitsSummary,
  volumeUnits,
  weightUnits,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useNow, useRecords, useUnits, useUploadProgress } from '../lib/app';
import { exportGrowthBook } from '../lib/book';
import { formatLastSeen } from '../lib/dates';
import { ensureNotificationPermission } from '../lib/notifications';
import { useTabScrollRef } from '../lib/tabScroll';
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

export function FamilyScreen() {
  const insets = useSafeAreaInsets();
  const scrollRef = useTabScrollRef('family');
  const app = useApp();
  const { moments, letters, baby, pendingCount } = useRecords();
  const uploadProgress = useUploadProgress();
  const units = useUnits();
  const pendingFiles = uploadProgress.total + uploadProgress.failedCount;
  const sheet = useSheet();
  const router = useRouter();
  const { toast } = useFeedback();
  const now = useNow(60_000);
  const [storageSummary, setStorageSummary] = useState('');
  const [exporting, setExporting] = useState(false);
  const { me, role, prefs } = app;
  const isAdmin = role === 'admin';
  const canRecord = role !== 'viewer';

  const loadStorage = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const [config, usage] = await Promise.all([app.api.getStorage(), app.api.storageUsage()]);
      if (config.source === 'none') {
        setStorageSummary('还没有配置，上传前需要先设置');
      } else {
        const name = config.provider ? storageProviderNames[config.provider] : '服务器默认存储';
        setStorageSummary(`${name} · 已用 ${usage.total ? formatBytes(usage.total) : '0'}`);
      }
    } catch {
      setStorageSummary('暂时读不到，联网后再看');
    }
  }, [app.api, isAdmin]);

  useEffect(() => {
    void loadStorage();
    void app.refreshMe();
  }, [loadStorage, app.refreshMe]);

  const others = (me?.members ?? []).filter((m) => m.userId !== me?.user.id);
  const otherName = others.length === 1 ? (others[0]?.label ?? '家人') : '家人';

  const signOut = () => {
    const unsynced = pendingCount > 0 || pendingFiles > 0;
    sheet.open('退出登录', () => (
      <>
        <Muted style={{ fontSize: 13, lineHeight: 21 }}>
          {unsynced
            ? `还有${pendingCount ? ` ${pendingCount} 条记录` : ''}${pendingCount && pendingFiles ? '和' : ''}${pendingFiles ? ` ${pendingFiles} 个文件` : ''}没有传到服务器，退出后会丢失。建议联网（视频要连 Wi-Fi）传完后再退出。`
            : '退出后手机上的数据会被清除，重新登录后会从服务器同步回来。'}
        </Muted>
        <Button
          testID="signout-confirm"
          tone={unsynced ? 'outline' : 'accent'}
          label={unsynced ? '仍然退出' : '退出登录'}
          onPress={() => {
            sheet.close();
            void app.signOut();
          }}
        />
      </>
    ));
  };

  const cancelInvite = (invite: { id: string; label: string }) => {
    sheet.open(`取消${invite.label}的邀请？`, () => (
      <>
        <Muted style={{ fontSize: 13, lineHeight: 21 }}>
          已经发出去的邀请码会立刻失效，之后想邀请可以重新生成。
        </Muted>
        <Button
          testID="invite-cancel-confirm"
          label="确定取消邀请"
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
      <PageTitle>家人</PageTitle>

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
              <Muted style={{ fontSize: 11 }}>已发送邀请 · {roleLabels[invite.role]}</Muted>
            </View>
            <Pressable
              testID={`invite-cancel-${invite.label}`}
              accessibilityRole="button"
              accessibilityLabel={`取消${invite.label}的邀请`}
              hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
              onPress={() => cancelInvite(invite)}
            >
              <Text style={{ fontSize: 11, color: colors.accent }}>取消</Text>
            </Pressable>
          </View>
        ))}
        {isAdmin ? (
          <Pressable
            testID="invite-open"
            accessibilityRole="button"
            accessibilityLabel="邀请家人"
            style={{ paddingVertical: 12 }}
            onPress={() => sheet.open('邀请家人', () => <InviteSheet />)}
          >
            <Text style={{ fontSize: 13, color: colors.accent }}>＋ 邀请家人</Text>
          </Pressable>
        ) : null}
      </ListCard>

      <View style={s.section}>
        <SectionTitle>同步与提醒</SectionTitle>
        <ListCard>
          {canRecord ? (
            <Toggle
              testID="pref-feed"
              label="喂奶提醒"
              sub="超过平时间隔时提醒，由这台手机发出"
              value={prefs.feedReminder}
              onChange={(v) => {
                void app.updatePrefs({ feedReminder: v });
                if (v) void ensureNotificationPermission();
              }}
            />
          ) : null}
          <Toggle
            testID="pref-family"
            label={`${otherName}记录时通知我`}
            sub="不用再问「刚刚喂了没」"
            value={prefs.familyNotify}
            onChange={(v) => void app.updatePrefs({ familyNotify: v })}
          />
          <Toggle
            testID="pref-night"
            label="夜间安静"
            sub="23:00–07:00 只提醒喂奶"
            value={prefs.quietNight}
            onChange={(v) => void app.updatePrefs({ quietNight: v })}
            last
          />
        </ListCard>
      </View>

      <View style={s.section}>
        <SectionTitle>设置</SectionTitle>
        <ListCard>
          {isAdmin ? (
            <NavRow
              testID="open-storage"
              label="存储"
              sub={storageSummary || '读取中…'}
              onPress={() => router.push('/storage')}
            />
          ) : null}
          {canRecord ? (
            <Toggle
              testID="pref-doc-lock"
              label="证件夹指纹解锁"
              sub="打开证件前需要验证指纹或锁屏密码"
              value={prefs.documentLock}
              onChange={(v) => void app.updatePrefs({ documentLock: v })}
            />
          ) : null}
          <NavRow
            testID="open-units"
            label="单位"
            sub={unitsSummary(units)}
            onPress={() => sheet.open('单位', () => <UnitsSheet />)}
          />
          <NavRow
            testID="export-book"
            label={exporting ? '正在生成成长册…' : '导出成长册'}
            sub="把回忆、照片和信整理成可打印的 PDF"
            onPress={() => {
              if (exporting || !baby) return;
              setExporting(true);
              exportGrowthBook(app.api, baby.data, moments, letters)
                .catch((e: Error) => toast(e.message || '生成失败，请稍后再试'))
                .finally(() => setExporting(false));
            }}
          />
          <NavRow
            testID="sign-out"
            label="退出登录"
            sub={me?.user.email ?? ''}
            onPress={signOut}
            last
          />
        </ListCard>
        <Muted style={{ fontSize: 11, textAlign: 'center', marginTop: 8 }}>
          小豆芽 · {app.serverUrl}
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
        {isMe ? '我' : seen.text}
      </Text>
    </Pressable>
  );
}

const UNIT_ROWS: { dimension: Dimension; label: string; options: readonly string[] }[] = [
  { dimension: 'volume', label: '奶量', options: volumeUnits },
  { dimension: 'temperature', label: '体温', options: temperatureUnits },
  { dimension: 'weight', label: '体重', options: weightUnits },
  { dimension: 'length', label: '身长', options: lengthUnits },
];

/** 单位是每个人自己的：爸爸看 oz、妈妈看 ml 都行，记录里存的都是公制。 */
function UnitsSheet() {
  const app = useApp();
  const { baby } = useRecords();
  const units = useUnits();
  const regionName = regionFor(baby?.data.region).name;
  return (
    <>
      {UNIT_ROWS.map(({ dimension, label, options }) => (
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
      <Muted style={{ fontSize: 12, lineHeight: 19 }}>
        只改变你看到的数字，记录都按公制保存。家人可以用不同的单位。
      </Muted>
      <Button
        testID="units-reset"
        tone="ghost"
        label={`恢复${regionName}的默认单位`}
        disabled={!app.prefs.units}
        onPress={() => void app.updatePrefs({ units: undefined })}
      />
    </>
  );
}

const LABEL_SUGGESTIONS = ['妈妈', '爸爸', '奶奶', '爷爷', '外婆', '外公', '阿姨'];
const ROLE_OPTIONS: { role: Role; hint: string }[] = [
  { role: 'caregiver', hint: '能记录和查看全部内容' },
  { role: 'viewer', hint: '只能看回忆、照片和信' },
  { role: 'admin', hint: '还能管理家人和存储' },
];

function RolePicker({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <View style={{ gap: 8 }}>
      {ROLE_OPTIONS.map((o) => {
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
      toast(error instanceof Error ? error.message : '生成失败');
    } finally {
      setBusy(false);
    }
  };

  if (code) {
    const formatted = `${code.slice(0, 4)} ${code.slice(4)}`;
    return (
      <>
        <Muted style={{ fontSize: 13, lineHeight: 21 }}>
          把邀请码发给{label}。在小豆芽的欢迎页选「我有邀请码」就能加入，7 天内有效，只能用一次。
        </Muted>
        <View style={s.codeBox}>
          <Mono weight="medium" style={s.code} testID="invite-code" selectable>
            {formatted}
          </Mono>
        </View>
        <Button
          testID="invite-share"
          label="发给家人"
          onPress={() =>
            void Share.share({
              message: `一起用小豆芽记录宝宝的成长吧。\n服务器：${app.serverUrl}\n邀请码：${formatted}\n7 天内有效。`,
            })
          }
        />
      </>
    );
  }

  return (
    <>
      <View style={s.chips}>
        {LABEL_SUGGESTIONS.map((v) => (
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
        placeholder="宝宝怎么称呼 TA？"
        maxLength={40}
      />
      <RolePicker value={role} onChange={setRole} />
      <Button
        testID="invite-create"
        label="生成邀请码"
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
      toast(error instanceof Error ? error.message : '操作失败');
    }
  };
  return (
    <>
      <RolePicker value={role} onChange={setRole} />
      <Button
        testID="member-save"
        label="保存"
        disabled={role === member.role}
        onPress={() => void run(() => app.api.updateMember(member.userId, { role }), '已更新')}
      />
      <Button
        testID="member-remove"
        tone="ghost"
        label={confirming ? `确定把${member.label}移出家庭？` : '移出家庭'}
        onPress={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          void run(() => app.api.removeMember(member.userId), `已把${member.label}移出家庭`);
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
