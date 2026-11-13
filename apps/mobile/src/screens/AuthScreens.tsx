import {
  birthMeasuresFromInput,
  convertMeasureText,
  DEFAULT_FAMILY_NAME,
  EMAIL_CODE_COOLDOWN_SECONDS,
  EMAIL_CODE_TTL_MINUTES,
  effectiveUnits,
  guessRegionId,
  messagesFor,
  scaleFor,
  t,
} from '@xiaodouya/shared';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { consentSegments } from '../lib/accountLogic';
import { Api } from '../lib/api';
import { useApp } from '../lib/app';
import { PRIVACY_URL, TERMS_URL } from '../lib/config';
import { deviceRegionCode } from '../lib/device';
import { colors, fonts, spacing, themedStyles } from '../theme';
import { BirthPicker } from '../ui/BirthPicker';
import { Button, Chip, Field, Muted, Serif } from '../ui/primitives';
import { RegionPicker } from '../ui/RegionPicker';
import { Text } from '../ui/Text';
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
      label={t().auth.serverAddress}
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
      accessibilityLabel={t().auth.changeServer}
      hitSlop={8}
      onPress={() => setOpen(true)}
    >
      <Muted numberOfLines={1}>{t().auth.serverLine(value)}</Muted>
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
      setError(e instanceof Error ? e.message : t().ui.somethingWrong);
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
      setError(e instanceof Error ? e.message : t().ui.somethingWrong);
      setBusy(false);
    }
  };

  const back = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t().common.back}
      hitSlop={12}
      onPress={step === 'reset' ? () => setStep('request') : onBack}
      testID="auth-back"
    >
      <Text style={s.back}>{t().auth.backLink}</Text>
    </Pressable>
  );

  if (step === 'request') {
    return (
      <Page testID="forgot-screen">
        {back}
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" style={s.title}>
            {t().account.forgotTitle}
          </Text>
          <Muted style={{ fontSize: 13 }}>{t().account.forgotHint}</Muted>
        </View>
        <View style={{ gap: 12 }}>
          <Field
            testID="field-email"
            label={t().auth.email}
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
          label={t().account.forgotSubmit}
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
          {t().account.resetTitle}
        </Text>
        <Muted style={{ fontSize: 13, lineHeight: 21 }}>
          {t().account.resetHint(email.trim(), EMAIL_CODE_TTL_MINUTES)}
        </Muted>
      </View>
      <View style={{ gap: 12 }}>
        <Field
          testID="field-reset-code"
          label={t().account.resetCode}
          mono
          keyboardType="number-pad"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChangeText={setCode}
        />
        <Field
          testID="field-new-password"
          label={t().account.resetNewPassword}
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
        label={t().account.resetSubmit}
        disabled={code.trim().length !== 6 || password.length < 8}
        busy={busy}
        onPress={() => void reset()}
      />
      <ResendButton testID="reset-resend" left={left} onPress={() => void request()} />
    </Page>
  );
}

/** 注册之后、建家庭之前。可以跳过：邮件服务出问题或邮箱填错时不能把人关在外面。 */
/** 称呼是用户自己的内容，选中后存下来的就是这段文字。testID 用固定的中文，不随语言变。 */
const selfLabels = () => [
  { id: messagesFor('zh').auth.dad, label: t().auth.dad },
  { id: messagesFor('zh').auth.mom, label: t().auth.mom },
];

export function VerifyEmailStep() {
  const app = useApp();
  return (
    <Page testID="verify-email-screen">
      <Text accessibilityRole="header" style={s.title}>
        {t().account.verifyTitle}
      </Text>
      <VerifyEmailForm onVerified={(me) => void app.finishEmailStep(me)} />
      <View style={{ gap: 4 }}>
        <Button
          testID="email-skip"
          tone="ghost"
          label={t().account.verifySkip}
          onPress={() => void app.finishEmailStep()}
        />
        <Muted style={s.note}>{t().account.verifySkipHint}</Muted>
      </View>
      <Button
        testID="verify-signout"
        tone="ghost"
        label={t().auth.signOut}
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
          displayName: name.trim() || t().auth.defaultName,
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
      setError(e instanceof Error ? e.message : t().ui.somethingWrong);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'welcome') {
    return (
      <Page testID="welcome-screen">
        <View style={s.brand}>
          <Text style={s.logo}>{t().common.appName}</Text>
          <Serif style={s.tagline}>{t().auth.tagline}</Serif>
        </View>
        <View style={{ gap: 10 }}>
          <Button testID="welcome-create" label={t().auth.start} onPress={() => go('register')} />
          <Button
            testID="welcome-join"
            tone="outline"
            label={t().auth.haveInvite}
            onPress={() => go('join')}
          />
          <Button
            testID="welcome-login"
            tone="ghost"
            label={t().auth.haveAccount}
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
          setNotice(t().account.resetDone);
        }}
      />
    );
  }

  const titles: Record<Exclude<Mode, 'welcome' | 'forgot'>, string> = {
    login: t().auth.welcomeBack,
    register: t().auth.createAccount,
    join: t().auth.joinFamily,
  };
  const complete =
    Boolean(email.trim()) &&
    password.length >= (mode === 'login' ? 1 : 8) &&
    (mode !== 'join' || Boolean(code.trim()));

  return (
    <Page testID={`${mode}-screen`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t().common.back}
        hitSlop={12}
        onPress={() => go('welcome')}
        testID="auth-back"
      >
        <Text style={s.back}>{t().auth.backLink}</Text>
      </Pressable>
      <Text accessibilityRole="header" style={s.title}>
        {titles[mode]}
      </Text>
      <View style={{ gap: 12 }}>
        {mode === 'join' ? (
          <Field
            testID="field-code"
            label={t().auth.inviteCode}
            mono
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder={t().auth.invitePlaceholder}
            value={code}
            onChangeText={setCode}
          />
        ) : null}
        {mode !== 'login' ? (
          <Field
            testID="field-name"
            label={t().auth.yourName}
            placeholder={mode === 'join' ? t().auth.optional : t().auth.optional}
            value={name}
            onChangeText={setName}
            maxLength={40}
          />
        ) : null}
        <Field
          testID="field-email"
          label={t().auth.email}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          value={email}
          onChangeText={setEmail}
        />
        <Field
          testID="field-password"
          label={mode === 'login' ? t().auth.password : t().auth.passwordRule}
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
        label={mode === 'login' ? t().auth.signIn : mode === 'join' ? t().auth.join : t().auth.next}
        disabled={!complete}
        busy={busy}
        onPress={() => void submit()}
      />
      {mode === 'login' && canReset ? (
        <Button
          testID="forgot-password"
          tone="ghost"
          label={t().account.forgotLink}
          onPress={() => go('forgot')}
        />
      ) : null}
      {mode === 'login' && !canReset ? (
        <Muted style={s.note}>{t().account.forgotDeployerNote}</Muted>
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
      await app.setMe(await app.api.createFamily(DEFAULT_FAMILY_NAME, label.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : t().auth.error);
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
      setError(e instanceof Error ? e.message : t().auth.error);
    } finally {
      setBusy(false);
    }
  };

  if (joining) {
    return (
      <Page testID="join-family-screen">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t().common.back}
          hitSlop={12}
          onPress={() => setJoining(false)}
        >
          <Text style={s.back}>{t().auth.backLink}</Text>
        </Pressable>
        <Text style={s.title}>{t().auth.joinFamily}</Text>
        <Field
          testID="field-code"
          label={t().auth.inviteCode}
          mono
          autoCapitalize="characters"
          autoCorrect={false}
          value={code}
          onChangeText={setCode}
        />
        <ErrorText message={error} />
        <Button
          testID="join-submit"
          label={t().auth.join}
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
        {t().auth.whoAreYou}
      </Text>
      <View style={s.chips}>
        {selfLabels().map(({ id, label: v }) => (
          <Chip
            key={id}
            testID={`self-${id}`}
            label={v}
            selected={label === v}
            onPress={() => setLabel(v)}
            style={s.bigChip}
          />
        ))}
      </View>
      <Field
        testID="field-label"
        label={t().auth.otherLabel}
        value={label}
        onChangeText={setLabel}
        maxLength={40}
      />
      <ErrorText message={error} />
      <Button
        testID="family-create"
        label={t().auth.next}
        disabled={!label.trim()}
        busy={busy}
        onPress={() => void create()}
      />
      <Button
        testID="family-join"
        tone="ghost"
        label={t().auth.haveInvite}
        onPress={() => setJoining(true)}
      />
      <Button
        testID="family-signout"
        tone="ghost"
        label={t().auth.signOut}
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
    if (birth.getTime() > Date.now()) return setError(t().auth.birthInFuture);
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
          {t().auth.meetBaby}
        </Text>
        <Muted style={{ fontSize: 13 }}>{t().auth.onlyRequired}</Muted>
      </View>
      <View style={{ gap: 12 }}>
        <Field
          testID="field-baby-name"
          label={t().auth.babyName}
          placeholder={t().auth.babyNamePlaceholder}
          value={name}
          onChangeText={setName}
          maxLength={40}
        />
        <BirthPicker value={birth} onChange={setBirth} />
        <View style={{ gap: 5 }}>
          <Muted style={{ fontSize: 12 }}>{t().auth.region}</Muted>
          <RegionPicker value={region} onChange={changeRegion} />
          <Muted style={{ fontSize: 11, lineHeight: 18 }}>{t().auth.regionHint}</Muted>
        </View>
        <View style={s.dateRow}>
          <View style={{ flex: 1 }}>
            <Field
              testID="field-baby-weight"
              label={t().auth.birthWeight(scaleFor('weight', units.weight).label)}
              keyboardType="decimal-pad"
              placeholder={units.weight === 'kg' ? '3.4' : '7.5'}
              value={weight}
              onChangeText={setWeight}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              testID="field-baby-length"
              label={t().auth.birthLength(scaleFor('length', units.length).label)}
              keyboardType="decimal-pad"
              placeholder={units.length === 'cm' ? '50' : '19.5'}
              value={length}
              onChangeText={setLength}
            />
          </View>
        </View>
        <Field
          testID="field-baby-hospital"
          label={t().auth.birthHospital}
          value={hospital}
          onChangeText={setHospital}
          maxLength={100}
        />
        <ErrorText message={error} />
      </View>
      <Button
        testID="baby-submit"
        label={t().auth.start}
        disabled={!name.trim()}
        onPress={() => void submit()}
      />
    </Page>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.paper },
  page: { flexGrow: 1, paddingHorizontal: spacing.page, gap: 24 },
  brand: { flex: 1, justifyContent: 'center', gap: 12, minHeight: 320 },
  logo: { fontFamily: fonts.serifBold, fontSize: 44, lineHeight: 56, color: colors.ink },
  tagline: { fontSize: 16, lineHeight: 28, color: colors.inkSoft },
  title: { fontFamily: fonts.serifBold, fontSize: 26, lineHeight: 34, color: colors.ink },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  error: { fontSize: 13, lineHeight: 20, color: colors.dangerText },
  note: { fontSize: 11, lineHeight: 18, textAlign: 'center' },
  notice: { fontSize: 13, lineHeight: 20, color: colors.greenText },
  consentLink: { color: colors.accentText },
  chips: { flexDirection: 'row', gap: 8 },
  bigChip: { flex: 1, paddingVertical: 14, backgroundColor: colors.card },
  dateRow: { flexDirection: 'row', gap: 8 },
}));
