import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, themedStyles } from '../theme';

/** Android 全面屏下内容会滚到状态栏后面，和时间、电量叠在一起。用一条纸色遮住。 */
export function StatusBarScrim() {
  const insets = useSafeAreaInsets();
  return <View pointerEvents="none" style={[s.scrim, { height: insets.top }]} />;
}

const s = themedStyles(() => ({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: colors.paper },
}));
