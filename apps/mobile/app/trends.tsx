import { Redirect } from 'expo-router';
import { useApp } from '../src/lib/app';
import { TrendsScreen } from '../src/screens/TrendsScreen';
import { StatusBarScrim } from '../src/ui/StatusBarScrim';

export default function Trends() {
  const { role } = useApp();
  // viewer 读不到记录（服务端不下发），今天页也没有入口，这里只是不让它进到一张空页面。
  if (role === 'viewer') return <Redirect href="/" />;
  return (
    <>
      <TrendsScreen />
      <StatusBarScrim />
    </>
  );
}
