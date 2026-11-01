import {
  birthMeasuresFromInput,
  convertMeasureText,
  EMAIL_CODE_COOLDOWN_SECONDS,
  effectiveUnits,
  guessRegionId,
  scaleFor,
} from '@xiaodouya/shared';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { consentSegments } from '../lib/accountLogic';
import { accountText } from '../lib/accountText';
import { Api } from '../lib/api';
import { useApp } from '../lib/app';
import { PRIVACY_URL, TERMS_URL } from '../lib/config';
import { deviceRegionCode } from '../lib/device';
import { colors, fonts, spacing } from '../theme';
import { BirthPicker } from '../ui/BirthPicker';
import { Button, Chip, Field, Muted, Serif } from '../ui/primitives';
import { RegionPicker } from '../ui/RegionPicker';
import { FormError, ResendButton, useCooldown, VerifyEmailForm } from './AccountPanels';

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

function ConsentLine() {
  const segments = consentSegments(TERMS_URL, PRIVACY_URL);
  if (!segments) return null;
  return (
    <Muted style={s.note}>
      {segments.map(({ text, url, testID }) =>
        url ? (
          <Text
            key={text}
            testID={testID}
            accessibilityRole="link"
            accessibilityLabel={text}
            style={s.consentLink}
            onPress={() => void Linking.openURL(url).catch(() => {})}
          >
            {text}
          </Text>
        ) : (
          text
        ),
      )}
    </Muted>
  );
}

/** 两步：填邮箱申请验证码，再填验证码和新密码。第一步的结果不说邮箱是否存在，服务端也不说。 */
function ForgotPassword({
  server,
  initialEmail,
  onBack,
  onDone,
}: {
  server: string;
  initialEmail: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useCooldown();
  const client = () => {
    const api = new Api();
    api.baseUrl = server.trim();
    return api;
  };

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      await client().forgotPassword(email.trim());
      setLeft(EMAIL_CODE_COOLDOWN_SECONDS);
      setStep('reset');
    } catch (e) {
      setError(e instanceof Error ? e.message : '出错了，请再试一次');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      await client().resetPassword({
        email: email.trim(),
        code: code.trim(),
        newPassword: password,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : '出错了，请再试一次');
      setBusy(false);
    }
  };

  const back = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="返回"
      hitSlop={12}
      onPress={step === 'reset' ? () => setStep('request') : onBack}
      testID="auth-back"
    >
      <Text style={s.back}>‹ 返回</Text>
    </Pressable>
  );

  if (step === 'request') {
    return (
      <Page testID="forgot-screen">
        {back}
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" style={s.title}>
            {accountText.forgotTitle}
          </Text>
          <Muted style={{ fontSize: 13 }}>{accountText.forgotHint}</Muted>
        </View>
        <View style={{ gap: 12 }}>
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
          <FormError message={error} />
        </View>
        <Button
          testID="forgot-submit"
          label={accountText.forgotSubmit}
          disabled={!email.trim()}
          busy={busy}
          onPress={() => void request()}
        />
      </Page>
    );
  }

  return (
    <Page testID="reset-screen">
      {back}
      <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={s.title}>
          {accountText.resetTitle}
        </Text>
        <Muted style={{ fontSize: 13, lineHeight: 21 }}>
          {accountText.resetHint(email.trim())}
        </Muted>
      </View>
      <View style={{ gap: 12 }}>
        <Field
          testID="field-reset-code"
          label={accountText.resetCode}
          mono
          keyboardType="number-pad"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChangeText={setCode}
        />
        <Field
          testID="field-new-password"
          label={accountText.resetNewPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={password}
          onChangeText={setPassword}
        />
        <FormError message={error} />
      </View>
      <Button
        testID="reset-submit"
        label={accountText.resetSubmit}
        disabled={code.trim().length !== 6 || password.length < 8}
        busy={busy}
        onPress={() => void reset()}
      />
      <ResendButton testID="reset-resend" left={left} onPress={() => void request()} />
    </Page>
  );
}

/** 注册之后、建家庭之前。可以跳过：邮件服务出问题或邮箱填错时不能把人关在外面。 */
export function VerifyEmailStep() {
  const app = useApp();
  return (
    <Page testID="verify-email-screen">
      <Text accessibilityRole="header" style={s.title}>
        {accountText.verifyTitle}
      </Text>
      <VerifyEmailForm onVerified={(me) => void app.finishEmailStep(me)} />
      <View style={{ gap: 4 }}>
        <Button
          testID="email-skip"
          tone="ghost"
          label={accountText.verifySkip}
          onPress={() => void app.finishEmailStep()}
        />
        <Muted style={s.note}>{accountText.verifySkipHint}</Muted>
      </View>
      <Button
        testID="verify-signout"
        tone="ghost"
        label="退出登录"
        onPress={() => void app.signOut()}
      />
    </Page>
  );
}

type Mode = 'welcome' | 'login' | 'register' | 'join' | 'forgot';

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
  const [notice, setNotice] = useState<string | null>(null);
  const [canReset, setCanReset] = useState(false);

  const go = (next: Mode) => {
    setError(null);
    setNotice(null);
    setMode(next);
  };

  // 服务器地址是用户可以改的，开没开邮件要问当前填的这一台。
  useEffect(() => {
    if (mode !== 'login') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const client = new Api();
      client.baseUrl = server.trim();
      void client.passwordResetEnabled().then((enabled) => {
        if (!cancelled) setCanReset(enabled);
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, server]);

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
        if (inviteCode) {
          // 要先走验证这一步的话，邀请码留到这一步结束后再用。
          const profile = await client.me();
          if (profile.emailVerified) await client.acceptInvite(inviteCode);
          else await app.deferInvite(inviteCode);
        }
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

  if (mode === 'forgot') {
    return (
      <ForgotPassword
        server={server}
        initialEmail={email}
        onBack={() => go('login')}
        onDone={() => {
          go('login');
          setPassword('');
          setNotice(accountText.resetDone);
        }}
      />
    );
  }

  const titles: Record<Exclude<Mode, 'welcome' | 'forgot'>, string> = {
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
        {notice ? (
          <Text testID="auth-notice" style={s.notice}>
            {notice}
          </Text>
        ) : null}
        <ErrorText message={error} />
      </View>
      <Button
        testID="auth-submit"
        label={mode === 'login' ? '登录' : mode === 'join' ? '加入' : '下一步'}
        disabled={!complete}
        busy={busy}
        onPress={() => void submit()}
      />
      {mode === 'login' && canReset ? (
        <Button
          testID="forgot-password"
          tone="ghost"
          label={accountText.forgotLink}
          onPress={() => go('forgot')}
        />
      ) : null}
      {mode === 'login' && !canReset ? (
        <Muted style={s.note}>{accountText.forgotDeployerNote}</Muted>
      ) : null}
      {mode !== 'login' ? <ConsentLine /> : null}
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
  const [weight, setWeight] = useState('');
  const [length, setLength] = useState('');
  const [hospital, setHospital] = useState('');
  const [region, setRegion] = useState(() => guessRegionId(deviceRegionCode()));
  const [error, setError] = useState<string | null>(null);
  const units = effectiveUnits(app.prefs.units, region);

  const changeRegion = (next: string) => {
    const nextUnits = effectiveUnits(app.prefs.units, next);
    setWeight((t) => convertMeasureText('weight', t, units.weight, nextUnits.weight));
    setLength((t) => convertMeasureText('length', t, units.length, nextUnits.length));
    setRegion(next);
  };

  const submit = async () => {
    const measures = birthMeasuresFromInput(weight, length, units);
    if (!measures.ok) return setError(measures.error);
    if (birth.getTime() > Date.now()) return setError('出生时间不能晚于现在');
    setError(null);
    await app.write(
      'baby',
      {
        name: name.trim(),
        birthAt: birth.getTime(),
        birthWeightKg: measures.weightKg,
        birthLengthCm: measures.lengthCm,
        hospital: hospital.trim() || undefined,
        region,
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
        <BirthPicker value={birth} onChange={setBirth} />
        <View style={{ gap: 5 }}>
          <Muted style={{ fontSize: 12 }}>所在地区</Muted>
          <RegionPicker value={region} onChange={changeRegion} />
          <Muted style={{ fontSize: 11, lineHeight: 18 }}>
            决定疫苗本和默认单位，以后可以在资料里改。
          </Muted>
        </View>
        <View style={s.dateRow}>
          <View style={{ flex: 1 }}>
            <Field
              testID="field-baby-weight"
              label={`出生体重（${scaleFor('weight', units.weight).label}）`}
              keyboardType="decimal-pad"
              placeholder={units.weight === 'kg' ? '3.4' : '7.5'}
              value={weight}
              onChangeText={setWeight}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              testID="field-baby-length"
              label={`出生身长（${scaleFor('length', units.length).label}）`}
              keyboardType="decimal-pad"
              placeholder={units.length === 'cm' ? '50' : '19.5'}
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
  notice: { fontSize: 13, lineHeight: 20, color: colors.green },
  consentLink: { color: colors.accent },
  chips: { flexDirection: 'row', gap: 8 },
  bigChip: { flex: 1, paddingVertical: 14, backgroundColor: colors.card },
  dateRow: { flexDirection: 'row', gap: 8 },
});
