import { t } from '@xiaodouya/shared';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useApp } from '../lib/app';
import { colors, spacing } from '../theme';
import { Button, Empty } from './primitives';

/** 同步到宝宝资料之前显示，否则新成员会看到一片空白，管理员还可能重复建档。 */
export function SyncingPlaceholder() {
  const { syncNow, syncStatus } = useApp();
  const [retrying, setRetrying] = useState(false);
  const offline = syncStatus === 'offline';
  return (
    <View style={s.root} testID="syncing-placeholder">
      {offline ? null : <ActivityIndicator color={colors.accent} />}
      <Empty
        title={offline ? t().ui.cantReachServer : t().ui.syncingFamily}
        sub={offline ? t().ui.firstUseNeedsNetwork : t().ui.firstSyncTakesTime}
      />
      {offline ? (
        <Button
          testID="sync-retry"
          label={t().ui.tryAgain}
          busy={retrying}
          onPress={() => {
            setRetrying(true);
            void syncNow().finally(() => setRetrying(false));
          }}
        />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.paper,
    justifyContent: 'center',
    paddingHorizontal: spacing.page,
  },
});
