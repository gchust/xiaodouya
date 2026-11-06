import {
  formatBytes,
  quotaStatus,
  type StorageConfigInput,
  type StorageConfigView,
  type StorageProvider,
  type StorageTestResult,
  type StorageUsage,
  storageProviderNames,
  storageTestMessage,
  t,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../lib/app';
import { canEditStorage, storagePageMode } from '../lib/storagePage';
import { colors, spacing, themedStyles } from '../theme';
import { useFeedback } from '../ui/overlays';
import {
  Button,
  Dot,
  Field,
  ListCard,
  Muted,
  PageTitle,
  SectionTitle,
  Toggle,
} from '../ui/primitives';
import { StorageUsagePage } from './StorageUsagePage';

const notes = (): Record<StorageProvider, string> => ({
  r2: t().storageUi.r2Note,
  s3: t().storageUi.s3Note,
  other: t().storageUi.otherNote,
});

interface Form {
  accountId: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

const emptyForm: Form = {
  accountId: '',
  endpoint: '',
  region: '',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  publicBaseUrl: '',
};

export function StorageScreen() {
  const app = useApp();
  const [allowCustom, setAllowCustom] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const allowed = await app.api.allowCustomStorage();
      setAllowCustom(allowed || canEditStorage(allowed, (await app.api.getStorage()).source));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t().storageUi.readFailed);
    }
  }, [app.api]);

  useEffect(() => {
    // 不是管理员的话不管服务器怎么答都只看用量，不用多等一次请求。
    if (app.role === 'admin') void load();
    else setAllowCustom(false);
  }, [app.role, load]);

  if (allowCustom === null) {
    return (
      <View style={[s.root, s.loading]} testID="storage-screen">
        {loadError ? (
          <>
            <Text style={{ color: colors.dangerText, fontSize: 13 }}>{loadError}</Text>
            <Button
              testID="storage-retry"
              tone="outline"
              label={t().storageUi.reread}
              height={44}
              style={{ borderRadius: 14, alignSelf: 'stretch' }}
              labelStyle={s.outlineLabel}
              onPress={() => void load()}
            />
          </>
        ) : (
          <ActivityIndicator color={colors.accent} />
        )}
      </View>
    );
  }
  return storagePageMode(app.role, allowCustom) === 'form' ? (
    <CustomStorageForm />
  ) : (
    <StorageUsagePage />
  );
}

function CustomStorageForm() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const app = useApp();
  const { toast } = useFeedback();
  const [config, setConfig] = useState<StorageConfigView | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [provider, setProvider] = useState<StorageProvider>('r2');
  const [form, setForm] = useState<Form>(emptyForm);
  const [test, setTest] = useState<StorageTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [c, u] = await Promise.all([app.api.getStorage(), app.api.storageUsage()]);
      setConfig(c);
      setUsage(u);
      if (c.provider) {
        setProvider(c.provider);
        setForm({
          accountId: c.accountId ?? '',
          endpoint: c.endpoint ?? '',
          region: c.region ?? '',
          bucket: c.bucket ?? '',
          accessKeyId: c.accessKeyId ?? '',
          secretAccessKey: '',
          publicBaseUrl: c.publicBaseUrl ?? '',
        });
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t().storageUi.readFailed);
    }
  }, [app.api]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (key: keyof Form) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setTest(null);
  };

  const body = (): StorageConfigInput => ({
    provider,
    accountId: provider === 'r2' ? form.accountId.trim() : undefined,
    endpoint: provider === 'other' ? form.endpoint.trim() : undefined,
    region: provider === 'r2' ? undefined : form.region.trim() || undefined,
    bucket: form.bucket.trim(),
    accessKeyId: form.accessKeyId.trim(),
    secretAccessKey: form.secretAccessKey || undefined,
    publicBaseUrl: form.publicBaseUrl.trim() || undefined,
  });

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await app.api.testStorage(body()));
    } catch (error) {
      setTest({
        ok: false,
        latencyMs: 0,
        message: error instanceof Error ? error.message : t().storageUi.connectFailed,
      });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      setConfig(await app.api.saveStorage(body()));
      setForm((f) => ({ ...f, secretAccessKey: '' }));
      toast(t().storageUi.settingsSaved);
      router.back();
    } catch (error) {
      setTest({
        ok: false,
        latencyMs: 0,
        message: error instanceof Error ? error.message : t().storageUi.saveFailed,
      });
    } finally {
      setSaving(false);
    }
  };

  const secretKept = Boolean(config?.provider === provider && config?.hasSecret);
  const complete =
    Boolean(form.bucket.trim() && form.accessKeyId.trim()) &&
    (provider !== 'r2' || Boolean(form.accountId.trim())) &&
    (provider !== 'other' || Boolean(form.endpoint.trim())) &&
    (Boolean(form.secretAccessKey) || secretKept);

  const total = usage?.total ?? 0;
  const quota = usage ? quotaStatus(usage) : null;
  const share = (value: number) =>
    (total > 0 ? `${Math.max(1, (value / total) * 100)}%` : '0%') as `${number}%`;
  const statusText =
    config?.source === 'family'
      ? t().storageUi.connected
      : config?.source === 'server'
        ? t().storageUi.usingDefault
        : config
          ? t().storageUi.notSet
          : '';

  return (
    <KeyboardAvoidingView
      style={s.root}
      testID="storage-screen"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[
          s.content,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: 8 }}>
          <Pressable
            testID="storage-back"
            accessibilityRole="button"
            accessibilityLabel={t().storageUi.backToFamily}
            hitSlop={12}
            onPress={() => router.back()}
          >
            <Text style={s.back}>{t().storageUi.backFamilyLink}</Text>
          </Pressable>
          <PageTitle>{t().family.storage}</PageTitle>
        </View>

        {loadError ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: colors.dangerText, fontSize: 13 }}>{loadError}</Text>
            <Button
              testID="storage-retry"
              tone="outline"
              label={t().storageUi.reread}
              height={44}
              style={{ borderRadius: 14 }}
              labelStyle={s.outlineLabel}
              onPress={() => void load()}
            />
          </View>
        ) : null}
        {!config && !loadError ? <ActivityIndicator color={colors.accent} /> : null}

        <View style={s.usageCard}>
          <View style={s.usageHead}>
            <Text style={{ fontSize: 15, fontWeight: '500', color: colors.ink }}>
              {config?.provider
                ? storageProviderNames[config.provider]
                : t().storageUi.currentStorage}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Dot color={config?.source === 'none' ? colors.accent : colors.green} size={7} />
              <Text
                testID="storage-status"
                style={{
                  fontSize: 12,
                  color: config?.source === 'none' ? colors.accentText : colors.greenText,
                }}
              >
                {statusText}
              </Text>
            </View>
          </View>
          <View style={s.bar}>
            {usage && total > 0 ? (
              <>
                <View style={{ width: share(usage.image), backgroundColor: colors.accent }} />
                <View style={{ width: share(usage.video), backgroundColor: colors.sleep }} />
                <View style={{ width: share(usage.audio), backgroundColor: colors.diaper }} />
                <View style={{ width: share(usage.document), backgroundColor: colors.green }} />
              </>
            ) : null}
          </View>
          <View style={s.usageLegend}>
            <Muted style={{ fontSize: 11 }}>
              {t().storageUi.photos(formatBytes(usage?.image ?? 0))}
            </Muted>
            <Muted style={{ fontSize: 11 }}>
              {t().storageUi.videos(formatBytes(usage?.video ?? 0))}
            </Muted>
            <Muted style={{ fontSize: 11 }}>
              {t().storageUi.audio(formatBytes(usage?.audio ?? 0))}
            </Muted>
            <Muted style={{ fontSize: 11 }}>
              {t().storageUi.docs(formatBytes(usage?.document ?? 0))}
            </Muted>
          </View>
          <Muted testID="storage-total">
            {t().storageUi.total(
              formatBytes(total),
              usage?.quota ? t().storageUi.limit(formatBytes(usage.quota)) : '',
            )}
          </Muted>
          {quota?.warning ? (
            <Text
              testID="storage-quota-warning"
              style={{
                fontSize: 12,
                lineHeight: 18,
                color: quota.level === 'full' ? colors.dangerText : colors.warnText,
              }}
            >
              {quota.warning}
            </Text>
          ) : null}
        </View>

        <View style={{ gap: 8 }}>
          <SectionTitle>{t().storageUi.provider}</SectionTitle>
          <View style={s.providers}>
            {(['r2', 's3', 'other'] as const).map((p) => {
              const on = provider === p;
              return (
                <Pressable
                  key={p}
                  testID={`provider-${p}`}
                  accessibilityRole="button"
                  accessibilityLabel={storageProviderNames[p]}
                  accessibilityState={{ selected: on }}
                  onPress={() => {
                    setProvider(p);
                    setTest(null);
                  }}
                  style={[s.provider, { backgroundColor: on ? colors.ink : colors.paper }]}
                >
                  <Text style={{ fontSize: 12, color: on ? colors.paper : colors.ink }}>
                    {p === 'other' ? t().storageUi.otherS3 : storageProviderNames[p]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Muted style={{ fontSize: 11, lineHeight: 18 }}>{notes()[provider]}</Muted>
        </View>

        <View style={{ gap: 10 }}>
          {provider === 'r2' ? (
            <Field
              testID="field-account"
              label="Account ID"
              mono
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t().storageUi.accountIdPlaceholder}
              value={form.accountId}
              onChangeText={set('accountId')}
            />
          ) : null}
          {provider === 'other' ? (
            <Field
              testID="field-endpoint"
              label="Endpoint"
              mono
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://s3.example.com"
              value={form.endpoint}
              onChangeText={set('endpoint')}
            />
          ) : null}
          {provider !== 'r2' ? (
            <Field
              testID="field-region"
              label="Region"
              mono
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={provider === 's3' ? 'us-east-1' : 'auto'}
              value={form.region}
              onChangeText={set('region')}
            />
          ) : null}
          <Field
            testID="field-bucket"
            label="Bucket"
            mono
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="baby-memories"
            value={form.bucket}
            onChangeText={set('bucket')}
          />
          <Field
            testID="field-key"
            label="Access Key ID"
            mono
            autoCapitalize="none"
            autoCorrect={false}
            value={form.accessKeyId}
            onChangeText={set('accessKeyId')}
          />
          <Field
            testID="field-secret"
            label="Secret Access Key"
            mono
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={secretKept ? t().storageUi.secretKept : ''}
            value={form.secretAccessKey}
            onChangeText={set('secretAccessKey')}
          />
          <Field
            testID="field-cdn"
            label={t().storageUi.cdn}
            mono
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://media.example.com"
            value={form.publicBaseUrl}
            onChangeText={set('publicBaseUrl')}
          />
          <Muted style={{ fontSize: 11, lineHeight: 18 }}>{t().storageUi.cdnHint}</Muted>
        </View>

        <View style={{ gap: 8 }}>
          <Button
            testID="storage-test"
            tone="outline"
            label={testing ? t().storageUi.testing : t().storageUi.testConnection}
            height={48}
            style={{ borderRadius: 14 }}
            labelStyle={s.outlineLabel}
            disabled={!complete || testing}
            onPress={() => void runTest()}
          />
          {test ? (
            <Text
              testID="storage-test-result"
              style={{ fontSize: 12, color: test.ok ? colors.greenText : colors.dangerText }}
            >
              {test.ok
                ? t().storageUi.testOk(
                    storageTestMessage(test.reason, test.message),
                    test.latencyMs,
                  )
                : t().storageUi.testFailed(storageTestMessage(test.reason, test.message))}
            </Text>
          ) : null}
        </View>

        <View style={{ gap: 8 }}>
          <SectionTitle>{t().storageUi.options}</SectionTitle>
          <ListCard>
            <Toggle
              testID="pref-wifi"
              label={t().storageUi.videoWifi}
              sub={t().storageUi.videoWifiSub}
              value={app.prefs.videoWifiOnly}
              onChange={(v) => void app.updatePrefs({ videoWifiOnly: v })}
              last
            />
          </ListCard>
          <Muted style={{ fontSize: 11, lineHeight: 18 }}>{t().storageUi.secretNote}</Muted>
        </View>

        <Button
          testID="storage-save"
          label={t().common.save}
          disabled={!complete}
          busy={saving}
          onPress={() => void save()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.paper },
  loading: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: spacing.page,
  },
  content: { paddingHorizontal: spacing.page, gap: 20 },
  back: { fontSize: 14, color: colors.muted, padding: 4, marginLeft: -4 },
  outlineLabel: { fontSize: 15, fontWeight: '400' },
  usageCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  usageHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  bar: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: colors.track,
  },
  usageLegend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 6 },
  providers: { flexDirection: 'row', gap: 6 },
  provider: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
  },
}));
