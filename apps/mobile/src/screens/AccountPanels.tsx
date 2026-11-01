import { accountDeletionOutcome, type MeResponse } from '@xiaodouya/shared';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { accountText } from '../lib/accountText';
import { useApp, useRecords, useUploadProgress } from '../lib/app';
import { colors } from '../theme';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Field, Muted } from '../ui/primitives';

/** 倒计时只为界面，真正的冷却在服务端。 */
export function useCooldown(): [number, (seconds: number) => void] {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return [left, setLeft];
}

export function ResendButton({
  testID,
  left,
  onPress,
}: {
  testID: string;
  left: number;
  onPress: () => void;
}) {
  const label = left > 0 ? accountText.verifyResendWait(left) : accountText.verifyResend;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: left > 0 }}
      disabled={left > 0}
      hitSlop={8}
      onPress={onPress}
    >
      <Text
        style={{
          fontSize: 13,
          textAlign: 'center',
          color: left > 0 ? colors.muted : colors.accent,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function FormError({ message }: { message: string | null }) {
  return message ? (
    <Text testID="form-error" style={{ fontSize: 13, lineHeight: 20, color: colors.danger }}>
      {message}
    </Text>
  ) : null;
}

/** 验证邮箱的表单：注册后的那一步和「家人」设置里共用。 */
export function VerifyEmailForm({ onVerified }: { onVerified: (me: MeResponse) => void }) {
  const app = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useCooldown();

  const resend = async () => {
    setError(null);
    try {
      const result = await app.api.sendEmailCode();
      setLeft(result.retryAfterSeconds);
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败，请稍后再试');
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onVerified(await app.api.verifyEmail(code.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : '出错了，请再试一次');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Muted style={{ fontSize: 13, lineHeight: 21 }}>
        {accountText.verifyHint(app.me?.user.email ?? '')}
      </Muted>
      <Field
        testID="field-email-code"
        label={accountText.resetCode}
        mono
        keyboardType="number-pad"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChangeText={setCode}
      />
      <FormError message={error} />
      <Button
        testID="email-verify-submit"
        label={accountText.verifySubmit}
        disabled={code.trim().length !== 6}
        busy={busy}
        onPress={() => void submit()}
      />
      <ResendButton testID="email-resend" left={left} onPress={() => void resend()} />
    </View>
  );
}

export function VerifyEmailSheet() {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  return (
    <VerifyEmailForm
      onVerified={(me) => {
        void app.setMe(me);
        sheet.close();
        toast(accountText.verifyDone);
      }}
    />
  );
}

export function DeleteAccountSheet() {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const { pendingCount } = useRecords();
  const uploads = useUploadProgress();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const me = app.me;
  const outcome = me ? accountDeletionOutcome(me.user.id, me.members) : 'no_family';

  if (outcome === 'blocked_only_admin') {
    return (
      <Muted testID="delete-blocked" style={{ fontSize: 13, lineHeight: 21 }}>
        {accountText.deleteBlocked}
      </Muted>
    );
  }

  const explanation = {
    no_family: accountText.deleteNoFamily,
    delete_family: accountText.deleteLastMember,
    leave_family: accountText.deleteLeave,
  }[outcome];
  const unsynced = pendingCount > 0 || uploads.total + uploads.failedCount > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await app.deleteAccount(password);
      sheet.close();
      toast(result === 'deleted' ? accountText.deleteDone : accountText.deleteSessionGone);
    } catch (e) {
      setError(e instanceof Error ? e.message : '出错了，请再试一次');
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Muted testID="delete-explanation" style={{ fontSize: 13, lineHeight: 21 }}>
        {explanation}
      </Muted>
      {unsynced ? (
        <Muted style={{ fontSize: 13, lineHeight: 21, color: colors.danger }}>
          {accountText.deleteUnsynced}
        </Muted>
      ) : null}
      <Field
        testID="delete-password"
        label={accountText.deletePassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        value={password}
        onChangeText={setPassword}
      />
      <FormError message={error} />
      <Button
        testID="delete-confirm"
        label={accountText.deleteConfirm}
        disabled={!password}
        busy={busy}
        onPress={() => void submit()}
      />
    </View>
  );
}
