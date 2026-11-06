import { Redirect } from 'expo-router';
import { useApp } from '../src/lib/app';
import { PiggyBankScreen } from '../src/screens/PiggyBankScreen';
import { StatusBarScrim } from '../src/ui/StatusBarScrim';

export default function PiggyBank() {
  const { role } = useApp();
  // viewer 本来也读不到小金库（服务端不下发 event），这里只是不让它进到一张空页面。
  if (role === 'viewer') return <Redirect href="/" />;
  return (
    <>
      <PiggyBankScreen />
      <StatusBarScrim />
    </>
  );
}
