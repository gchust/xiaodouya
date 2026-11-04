import { Redirect } from 'expo-router';
import { Platform } from 'react-native';
import { useApp } from '../src/lib/app';
import { WidgetsScreen } from '../src/screens/WidgetsScreen';
import { StatusBarScrim } from '../src/ui/StatusBarScrim';

export default function Widgets() {
  const { role } = useApp();
  // 小工具只有 Android 有；只看回忆的家人放了也只会看到“看不了记录”，不给入口。
  if (Platform.OS !== 'android' || role === 'viewer') return <Redirect href="/" />;
  return (
    <>
      <WidgetsScreen />
      <StatusBarScrim />
    </>
  );
}
