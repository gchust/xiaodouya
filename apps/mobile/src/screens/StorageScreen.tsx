import {
  formatBytes,
  type StorageConfigInput,
  type StorageConfigView,
  type StorageProvider,
  type StorageTestResult,
  type StorageUsage,
  storageProviderNames,
} from '@xiaodouya/shared';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../lib/app';
import { colors, spacing } from '../theme';
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

const NOTES: Record<StorageProvider, string> = {
  r2: '推荐。下载流量不收费，适合照片和视频多的情况。创建 Bucket 时位置选离家人最近的区域。',
  s3: '选离家人最近的区域，数据就存在那里，但下载流量要收费。',
  other: '适用于 Backblaze B2、Wasabi、阿里云 OSS、自建 MinIO 等任何兼容 S3 接口的存储。',
};

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
      setLoadError(error instanceof Error ? error.message : '读取失败');
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
        message: error instanceof Error ? error.message : '连接失败',
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
      toast('存储设置已保存');
      router.back();
    } catch (error) {
      setTest({
        ok: false,
        latencyMs: 0,
        message: error instanceof Error ? error.message : '保存失败',
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
  const share = (value: number) =>
    (total > 0 ? `${Math.max(1, (value / total) * 100)}%` : '0%') as `${number}%`;
  const statusText =
    config?.source === 'family'
      ? '已连接'
      : config?.source === 'server'
        ? '正在使用服务器默认存储'
        : config
          ? '还没有配置'
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
            accessibilityLabel="返回家人"
            hitSlop={12}
            onPress={() => router.back()}
          >
            <Text style={s.back}>‹ 家人</Text>
          </Pressable>
          <PageTitle>存储</PageTitle>
        </View>

        {loadError ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: colors.danger, fontSize: 13 }}>{loadError}</Text>
            <Button
              testID="storage-retry"
              tone="outline"
              label="重新读取"
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
              {config?.provider ? storageProviderNames[config.provider] : '当前存储'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Dot color={config?.source === 'none' ? colors.accent : colors.green} size={7} />
              <Text
                testID="storage-status"
                style={{
                  fontSize: 12,
                  color: config?.source === 'none' ? colors.accent : colors.green,
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
            <Muted style={{ fontSize: 11 }}>照片 {formatBytes(usage?.image ?? 0)}</Muted>
            <Muted style={{ fontSize: 11 }}>视频 {formatBytes(usage?.video ?? 0)}</Muted>
            <Muted style={{ fontSize: 11 }}>录音 {formatBytes(usage?.audio ?? 0)}</Muted>
            <Muted style={{ fontSize: 11 }}>证件 {formatBytes(usage?.document ?? 0)}</Muted>
          </View>
          <Muted testID="storage-total">
            共 {formatBytes(total)} · 文件从手机直传，不经过服务器
          </Muted>
        </View>

        <View style={{ gap: 8 }}>
          <SectionTitle>服务商</SectionTitle>
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
                    {p === 'other' ? '其他 S3 兼容' : storageProviderNames[p]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Muted style={{ fontSize: 11, lineHeight: 18 }}>{NOTES[provider]}</Muted>
        </View>

        <View style={{ gap: 10 }}>
          {provider === 'r2' ? (
            <Field
              testID="field-account"
              label="Account ID"
              mono
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Cloudflare 控制台右侧可找到"
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
            placeholder={secretKept ? '已保存，不改就留空' : ''}
            value={form.secretAccessKey}
            onChangeText={set('secretAccessKey')}
          />
          <Field
            testID="field-cdn"
            label="公开 CDN 域名（可选）"
            mono
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://media.example.com"
            value={form.publicBaseUrl}
            onChangeText={set('publicBaseUrl')}
          />
          <Muted style={{ fontSize: 11, lineHeight: 18 }}>
            留空时所有文件都用短时效的签名链接，最私密。填写后，照片和视频走这个公开地址，加载更快，但地址不会过期（文件名不可猜）。证件始终只走签名链接。
          </Muted>
        </View>

        <View style={{ gap: 8 }}>
          <Button
            testID="storage-test"
            tone="outline"
            label={testing ? '测试中…' : '测试连接'}
            height={48}
            style={{ borderRadius: 14 }}
            labelStyle={s.outlineLabel}
            disabled={!complete || testing}
            onPress={() => void runTest()}
          />
          {test ? (
            <Text
              testID="storage-test-result"
              style={{ fontSize: 12, color: test.ok ? colors.green : colors.danger }}
            >
              {test.ok
                ? `连接成功 · ${test.message} · ${test.latencyMs}ms`
                : `连接失败：${test.message}`}
            </Text>
          ) : null}
        </View>

        <View style={{ gap: 8 }}>
          <SectionTitle>选项</SectionTitle>
          <ListCard>
            <Toggle
              testID="pref-wifi"
              label="视频只在 Wi-Fi 下上传"
              sub="用流量时先排队，连上 Wi-Fi 自动继续"
              value={app.prefs.videoWifiOnly}
              onChange={(v) => void app.updatePrefs({ videoWifiOnly: v })}
              last
            />
          </ListCard>
          <Muted style={{ fontSize: 11, lineHeight: 18 }}>
            证件始终私有，打开时生成 10
            分钟有效的链接。密钥只保存在服务器上并加密，不会存到任何人的手机里。
          </Muted>
        </View>

        <Button
          testID="storage-save"
          label="保存"
          disabled={!complete}
          busy={saving}
          onPress={() => void save()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
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
    backgroundColor: '#efe7dc',
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
});
