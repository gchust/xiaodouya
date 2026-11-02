import { t } from '@xiaodouya/shared';
import { Redirect, Tabs } from 'expo-router';
import { useApp } from '../../src/lib/app';
import { PendingPickRecovery } from '../../src/lib/pendingPick';
import { colors } from '../../src/theme';
import { StatusBarScrim } from '../../src/ui/StatusBarScrim';
import { TabBar } from '../../src/ui/TabBar';

export default function TabsLayout() {
  const { sessionState, role } = useApp();
  // 退出登录或被移出家庭时，无论在哪一页都回到入口。
  if (sessionState !== 'ready') return <Redirect href="/" />;
  const viewer = role === 'viewer';
  return (
    <>
      <Tabs
        tabBar={(props) => <TabBar {...props} />}
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.paper } }}
      >
        <Tabs.Screen
          name="today"
          options={{ title: t().ui.tabToday, href: viewer ? null : undefined }}
        />
        <Tabs.Screen name="recall" options={{ title: t().ui.tabRecall }} />
        <Tabs.Screen
          name="info"
          options={{ title: t().ui.tabInfo, href: viewer ? null : undefined }}
        />
        <Tabs.Screen name="family" options={{ title: t().ui.tabFamily }} />
      </Tabs>
      <StatusBarScrim />
      {viewer ? null : <PendingPickRecovery />}
    </>
  );
}
