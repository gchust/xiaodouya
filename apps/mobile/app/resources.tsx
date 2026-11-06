import { Redirect } from 'expo-router';
import { useApp } from '../src/lib/app';
import { ResourcesScreen } from '../src/screens/ResourcesScreen';
import { StatusBarScrim } from '../src/ui/StatusBarScrim';

export default function Page() {
  const { role } = useApp();
  // viewer 本来也读不到（服务端不下发 event），这里只是不让它进到一张空页面。
  if (role === 'viewer') return <Redirect href="/" />;
  return (
    <>
      <ResourcesScreen />
      <StatusBarScrim />
    </>
  );
}
