import { type AppUpdateInfo, formatBytes, getLocale, releaseNotesFor, t } from '@xiaodouya/shared';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useApp } from '../lib/app';
import type { UpdateController, UpdatePhase } from '../lib/appUpdate';
import {
  currentAppVersion,
  getUpdateController,
  openInstallSettings,
  useCanInstallPackages,
  useUpdatePhase,
} from '../lib/appUpdateRuntime';
import { colors, fonts } from '../theme';
import { useSheet } from '../ui/overlays';
import { Body, Button, Dot, Mono, Muted } from '../ui/primitives';

/** 设置里“检查更新”这一行的副标题。 */
export function updateRowSub(phase: UpdatePhase, currentName: string): string {
  switch (phase.kind) {
    case 'checking':
      return t().update.rowChecking;
    case 'downloading':
      return `${t().update.downloading} ${percent(phase.received, phase.total)}%`;
    case 'available':
    case 'verifying':
    case 'ready':
      return t().update.rowAvailable(phase.update.versionName);
    default:
      return t().update.rowCurrent(currentName);
  }
}

const percent = (received: number, total: number) =>
  total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;

/** 关掉弹层不停下载：状态在 UpdateController 里，再打开时接着显示进度。 */
export function UpdateSheet() {
  const app = useApp();
  const updates = getUpdateController(app.api, app.db);
  const phase = useUpdatePhase(updates);
  const version = currentAppVersion();

  // 打开时没有结果（或上次没查到）就查一次；自动检查已经查到的不用再问。
  useEffect(() => {
    const state = updates?.getState();
    if (!state) return;
    if (
      state.kind === 'idle' ||
      state.kind === 'upToDate' ||
      (state.kind === 'failed' && !state.update)
    ) {
      void updates?.check();
    }
  }, [updates]);

  if (!updates || !version) return null;
  if (phase.kind === 'idle' || phase.kind === 'checking') {
    return <Muted style={s.note}>{t().update.checking}</Muted>;
  }
  if (phase.kind === 'upToDate') {
    return (
      <View style={s.statusRow} testID="update-latest">
        <Dot color={colors.green} size={8} />
        <Body>{t().update.upToDate(version.name)}</Body>
      </View>
    );
  }
  const update = phase.update;
  if (!update) {
    return (
      <>
        <Text style={s.error} testID="update-error">
          {t().update.failedCheck}
        </Text>
        <Button
          testID="update-recheck"
          tone="outline"
          label={t().update.retry}
          onPress={() => void updates.check()}
        />
      </>
    );
  }
  return (
    <>
      <Header update={update} currentName={version.name} />
      <Actions phase={phase} updates={updates} />
    </>
  );
}

function Header({ update, currentName }: { update: AppUpdateInfo; currentName: string }) {
  const notes = releaseNotesFor(update.notes, getLocale());
  return (
    <View style={{ gap: 6 }} testID="update-available">
      <View style={s.versionRow}>
        <Muted style={{ fontSize: 13 }}>{t().update.newVersion}</Muted>
        <Mono weight="medium" style={s.version}>
          {update.versionName}
        </Mono>
      </View>
      <Muted style={{ fontSize: 12 }}>
        {t().update.currentAndSize(currentName, formatBytes(update.size))}
      </Muted>
      {update.required ? (
        <View style={s.tip}>
          <Text style={s.tipText}>{t().update.required}</Text>
        </View>
      ) : null}
      {notes ? (
        <View style={{ gap: 4, marginTop: 6 }}>
          <Text style={s.notesTitle}>{t().update.notesTitle}</Text>
          <Body style={s.notes}>{notes}</Body>
        </View>
      ) : null}
    </View>
  );
}

function Actions({
  phase,
  updates,
}: {
  phase: Exclude<UpdatePhase, { kind: 'idle' | 'checking' | 'upToDate' }>;
  updates: UpdateController;
}) {
  const sheet = useSheet();
  const canInstall = useCanInstallPackages();
  switch (phase.kind) {
    case 'available':
      return (
        <>
          <Muted style={s.note}>{t().update.keepsData}</Muted>
          <Button
            testID="update-start"
            label={t().update.update}
            onPress={() => void updates.download()}
          />
          <Button
            testID="update-later"
            tone="ghost"
            label={t().update.later}
            onPress={sheet.close}
            height={44}
          />
        </>
      );
    case 'downloading': {
      const pct = percent(phase.received, phase.total);
      return (
        <>
          <View style={{ gap: 8 }} testID="update-progress">
            <View style={s.progressRow}>
              <Muted style={{ fontSize: 12 }}>{t().update.downloading}</Muted>
              <Mono style={s.progressText}>
                {t().update.downloaded(formatBytes(phase.received), formatBytes(phase.total))} ·{' '}
                {pct}%
              </Mono>
            </View>
            <View style={s.track}>
              <View style={[s.bar, { width: `${pct}%` }]} />
            </View>
          </View>
          <Button
            testID="update-cancel"
            tone="outline"
            label={t().update.cancelDownload}
            onPress={() => updates.cancel()}
          />
        </>
      );
    }
    case 'verifying':
      return <Muted style={s.note}>{t().update.verifying}</Muted>;
    case 'ready':
      return canInstall ? (
        <>
          <View style={s.statusRow}>
            <Dot color={colors.green} size={8} />
            <Body>{t().update.readyTitle}</Body>
          </View>
          <Button
            testID="update-install"
            label={t().update.install}
            onPress={() => void updates.install()}
          />
          <Muted style={s.note}>{t().update.installHint}</Muted>
        </>
      ) : (
        <>
          <View style={s.tip}>
            <Text style={s.tipText}>{t().update.needPermission}</Text>
          </View>
          <Button
            testID="update-open-settings"
            label={t().update.openSettings}
            onPress={openInstallSettings}
          />
        </>
      );
    case 'failed': {
      const message = {
        check: t().update.failedCheck,
        network: t().update.failedNetwork,
        checksum: t().update.failedChecksum,
        install: t().update.failedInstall,
      }[phase.reason];
      return (
        <>
          <Text style={s.error} testID="update-error">
            {message}
          </Text>
          <Button
            testID="update-retry"
            label={t().update.retry}
            // 安装界面没打开时，下好的文件还在：download 会先核对它，不会重新下载。
            onPress={() => void updates.download()}
          />
        </>
      );
    }
  }
}

const s = StyleSheet.create({
  versionRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  version: { fontSize: 26, color: colors.ink },
  note: { fontSize: 12, lineHeight: 19 },
  notesTitle: { fontFamily: fonts.serifBold, fontSize: 14, color: colors.ink },
  notes: { fontSize: 13, lineHeight: 21, color: colors.inkSoft },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  progressText: { fontSize: 12, color: colors.inkSoft },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.rule, overflow: 'hidden' },
  bar: { height: 4, borderRadius: 2, backgroundColor: colors.accent },
  tip: { backgroundColor: colors.sand, borderRadius: 12, padding: 12, marginTop: 4 },
  tipText: { fontSize: 13, lineHeight: 20, color: colors.inkSoft },
  error: { fontSize: 13, lineHeight: 20, color: colors.danger },
});
