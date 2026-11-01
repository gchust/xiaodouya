import DateTimePicker from '@react-native-community/datetimepicker';
import { formatClock, formatFullDate } from '@xiaodouya/shared';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Api } from '../lib/api';
import { useApp } from '../lib/app';
import { colors, fonts, spacing } from '../theme';
import { Button, Chip, Field, Muted, Serif } from '../ui/primitives';

function Page({ children, testID }: { children: React.ReactNode; testID: string }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      testID={testID}
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[
          s.page,
          { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 28 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <Text testID="form-error" style={s.error}>
      {message}
    </Text>
  ) : null;
}

function ServerField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <Field
      testID="field-server"
      label="服务器地址"
      mono
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType="url"
      value={value}
      onChangeText={onChange}
    />
  ) : (
    <Pressable
      testID="server-toggle"
      accessibilityRole="button"
      accessibilityLabel="修改服务器地址"
      hitSlop={8}
      onPress={() => setOpen(true)}
    >
      <Muted numberOfLines={1}>服务器：{value} · 修改</Muted>
    </Pressable>
  );
}

type Mode = 'welcome' | 'login' | 'register' | 'join';

export function AuthFlow() {
  const app = useApp();
  const [mode, setMode] = useState<Mode>('welcome');
  const [server, setServer] = useState(app.serverUrl);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (next: Mode) => {
    setError(null);
    setMode(next);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const client = new Api();
      client.baseUrl = server.trim();
      if (mode === 'login') {
        const result = await client.login({ email: email.trim(), password });
        await app.signIn(result.token, server.trim());
      } else {
        const inviteCode = mode === 'join' ? code.trim() : undefined;
        const result = await client.register({
          email: email.trim(),
          password,
          displayName: name.trim() || '家人',
          inviteCode,
        });
        client.token = result.token;
        if (inviteCode) await client.acceptInvite(inviteCode);
        await app.signIn(result.token, server.trim());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '出错了，请再试一次');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'welcome') {
    return (
      <Page testID="welcome-screen">
        <View style={s.brand}>
          <Text style={s.logo}>小豆芽</Text>
          <Serif style={s.tagline}>一家人，一起记下宝宝长大的每一天。</Serif>
        </View>
        <View style={{ gap: 10 }}>
          <Button testID="welcome-create" label="开始记录" onPress={() => go('register')} />
          <Button
            testID="welcome-join"
            tone="outline"
            label="我有邀请码"
            onPress={() => go('join')}
          />
          <Button
            testID="welcome-login"
            tone="ghost"
            label="已有账号，登录"
            onPress={() => go('login')}
          />
        </View>
      </Page>
    );
  }

  const titles: Record<Exclude<Mode, 'welcome'>, string> = {
    login: '欢迎回来',
    register: '创建账号',
    join: '加入家庭',
  };
  const complete =
    Boolean(email.trim()) &&
    password.length >= (mode === 'login' ? 1 : 8) &&
    (mode !== 'join' || Boolean(code.trim()));

  return (
    <Page testID={`${mode}-screen`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="返回"
        hitSlop={12}
        onPress={() => go('welcome')}
        testID="auth-back"
      >
        <Text style={s.back}>‹ 返回</Text>
      </Pressable>
      <Text accessibilityRole="header" style={s.title}>
        {titles[mode]}
      </Text>
      <View style={{ gap: 12 }}>
        {mode === 'join' ? (
          <Field
            testID="field-code"
            label="邀请码"
            mono
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="家人发给你的 8 位邀请码"
            value={code}
            onChangeText={setCode}
          />
        ) : null}
        {mode !== 'login' ? (
          <Field
            testID="field-name"
            label="你的名字"
            placeholder={mode === 'join' ? '可以不填' : '可以不填'}
            value={name}
            onChangeText={setName}
            maxLength={40}
          />
        ) : null}
        <Field
          testID="field-email"
          label="邮箱"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          value={email}
          onChangeText={setEmail}
        />
        <Field
          testID="field-password"
          label={mode === 'login' ? '密码' : '密码（至少 8 位）'}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={password}
          onChangeText={setPassword}
        />
        <ServerField value={server} onChange={setServer} />
        <ErrorText message={error} />
      </View>
      <Button
        testID="auth-submit"
        label={mode === 'login' ? '登录' : mode === 'join' ? '加入' : '下一步'}
        disabled={!complete}
        busy={busy}
        onPress={() => void submit()}
      />
      {mode === 'login' ? (
        <Muted style={s.note}>
          忘记密码？这个 App 由你们家自己部署，请部署它的人在服务器上重置。
        </Muted>
      ) : null}
    </Page>
  );
}

/** 已登录但还没有家庭：比如之前被移出，或者注册后中断了流程。 */
export function FamilySetup() {
  const app = useApp();
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await app.setMe(await app.api.createFamily('我们家', label.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : '出错了');
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      await app.setMe(await app.api.acceptInvite(code.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : '出错了');
    } finally {
      setBusy(false);
    }
  };

  if (joining) {
    return (
      <Page testID="join-family-screen">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="返回"
          hitSlop={12}
          onPress={() => setJoining(false)}
        >
          <Text style={s.back}>‹ 返回</Text>
        </Pressable>
        <Text style={s.title}>加入家庭</Text>
        <Field
          testID="field-code"
          label="邀请码"
          mono
          autoCapitalize="characters"
          autoCorrect={false}
          value={code}
          onChangeText={setCode}
        />
        <ErrorText message={error} />
        <Button
          testID="join-submit"
          label="加入"
          disabled={!code.trim()}
          busy={busy}
          onPress={() => void join()}
        />
      </Page>
    );
  }

  return (
    <Page testID="family-setup-screen">
      <Text accessibilityRole="header" style={s.title}>
        你是宝宝的？
      </Text>
      <View style={s.chips}>
        {['爸爸', '妈妈'].map((v) => (
          <Chip
            key={v}
            testID={`self-${v}`}
            label={v}
            selected={label === v}
            onPress={() => setLabel(v)}
            style={s.bigChip}
          />
        ))}
      </View>
      <Field
        testID="field-label"
        label="或者填写其他称呼"
        value={label}
        onChangeText={setLabel}
        maxLength={40}
      />
      <ErrorText message={error} />
      <Button
        testID="family-create"
        label="下一步"
        disabled={!label.trim()}
        busy={busy}
        onPress={() => void create()}
      />
      <Button
        testID="family-join"
        tone="ghost"
        label="我有邀请码"
        onPress={() => setJoining(true)}
      />
      <Button
        testID="family-signout"
        tone="ghost"
        label="退出登录"
        onPress={() => void app.signOut()}
      />
    </Page>
  );
}

/** 管理员第一次进入：告诉我们宝宝的基本信息。今天页的一切都从出生时间算起。 */
export function BabySetup() {
  const app = useApp();
  const [name, setName] = useState('');
  const [birth, setBirth] = useState(() => {
    const d = new Date();
    d.setSeconds(0, 0);
    return d;
  });
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);
  const [weight, setWeight] = useState('');
  const [length, setLength] = useState('');
  const [hospital, setHospital] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const w = weight ? Number.parseFloat(weight) : undefined;
    const l = length ? Number.parseFloat(length) : undefined;
    if (w !== undefined && !(w >= 0.3 && w <= 10)) return setError('体重看起来不太对，单位是公斤');
    if (l !== undefined && !(l >= 20 && l <= 80)) return setError('身长看起来不太对，单位是厘米');
    if (birth.getTime() > Date.now()) return setError('出生时间不能晚于现在');
    setError(null);
    await app.write(
      'baby',
      {
        name: name.trim(),
        birthAt: birth.getTime(),
        birthWeightKg: w,
        birthLengthCm: l,
        hospital: hospital.trim() || undefined,
      },
      // 用家庭 id 做宝宝记录的 id：一个家庭一份档案，两台手机同时建档也只会有一条。
      app.me?.family?.id,
    );
  };

  return (
    <Page testID="baby-setup-screen">
      <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={s.title}>
          认识一下宝宝
        </Text>
        <Muted style={{ fontSize: 13 }}>只有名字和出生时间是必填的，其他以后再补也行。</Muted>
      </View>
      <View style={{ gap: 12 }}>
        <Field
          testID="field-baby-name"
          label="名字或小名"
          placeholder="比如：小豆芽"
          value={name}
          onChangeText={setName}
          maxLength={40}
        />
        <View style={{ gap: 5 }}>
          <Muted style={{ fontSize: 12 }}>出生时间</Muted>
          <View style={s.dateRow}>
            <Pressable
              testID="birth-date"
              accessibilityRole="button"
              accessibilityLabel="选择出生日期"
              onPress={() => setPicker('date')}
              style={s.dateBtn}
            >
              <Text style={s.dateText}>{formatFullDate(birth.getTime())}</Text>
            </Pressable>
            <Pressable
              testID="birth-time"
              accessibilityRole="button"
              accessibilityLabel="选择出生时刻"
              onPress={() => setPicker('time')}
              style={s.dateBtn}
            >
              <Text style={s.dateText}>{formatClock(birth.getTime())}</Text>
            </Pressable>
          </View>
        </View>
        {picker ? (
          <DateTimePicker
            value={birth}
            mode={picker}
            is24Hour
            maximumDate={picker === 'date' ? new Date() : undefined}
            onChange={(_event, date) => {
              setPicker(null);
              if (date) setBirth(date);
            }}
          />
        ) : null}
        <View style={s.dateRow}>
          <View style={{ flex: 1 }}>
            <Field
              testID="field-baby-weight"
              label="出生体重（kg）"
              keyboardType="decimal-pad"
              placeholder="3.4"
              value={weight}
              onChangeText={setWeight}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              testID="field-baby-length"
              label="出生身长（cm）"
              keyboardType="decimal-pad"
              placeholder="50"
              value={length}
              onChangeText={setLength}
            />
          </View>
        </View>
        <Field
          testID="field-baby-hospital"
          label="出生医院"
          value={hospital}
          onChangeText={setHospital}
          maxLength={100}
        />
        <ErrorText message={error} />
      </View>
      <Button
        testID="baby-submit"
        label="开始记录"
        disabled={!name.trim()}
        onPress={() => void submit()}
      />
    </Page>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  page: { flexGrow: 1, paddingHorizontal: spacing.page, gap: 24 },
  brand: { flex: 1, justifyContent: 'center', gap: 12, minHeight: 320 },
  logo: { fontFamily: fonts.serifBold, fontSize: 44, lineHeight: 56, color: colors.ink },
  tagline: { fontSize: 16, lineHeight: 28, color: colors.inkSoft },
  title: { fontFamily: fonts.serifBold, fontSize: 26, lineHeight: 34, color: colors.ink },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  error: { fontSize: 13, lineHeight: 20, color: colors.danger },
  note: { fontSize: 11, lineHeight: 18, textAlign: 'center' },
  chips: { flexDirection: 'row', gap: 8 },
  bigChip: { flex: 1, paddingVertical: 14, backgroundColor: colors.card },
  dateRow: { flexDirection: 'row', gap: 8 },
  dateBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 13,
  },
  dateText: { fontFamily: fonts.monoRegular, fontSize: 14, color: colors.ink },
});
