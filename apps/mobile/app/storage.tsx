import { Redirect } from 'expo-router';
import { useApp } from '../src/lib/app';
import { StorageScreen } from '../src/screens/StorageScreen';

import { StatusBarScrim } from '../src/ui/StatusBarScrim';

export default function Storage() {
  const { role } = useApp();
  if (role !== 'admin') return <Redirect href="/family" />;
  return (
    <>
      <StorageScreen />
      <StatusBarScrim />
    </>
  );
}
