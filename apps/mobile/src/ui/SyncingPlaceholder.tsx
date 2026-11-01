import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { colors } from '../theme';
import { Empty } from './primitives';

/** 刚加入家庭还没同步到宝宝资料时显示，否则新成员会看到一片空白。 */
export function SyncingPlaceholder() {
  return (
    <View style={s.root} testID="syncing-placeholder">
      <ActivityIndicator color={colors.accent} />
      <Empty
        title="正在同步家人的记录"
        sub="第一次同步需要一点时间。如果一直没有内容，请检查网络。"
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper, justifyContent: 'center' },
});
