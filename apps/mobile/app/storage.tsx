import { Redirect } from 'expo-router';
import { useApp } from '../src/lib/app';
import { canOpenStorage } from '../src/lib/storagePage';
import { StorageScreen } from '../src/screens/StorageScreen';

import { StatusBarScrim } from '../src/ui/StatusBarScrim';

export default function Storage() {
  const { role } = useApp();
  if (!canOpenStorage(role)) return <Redirect href="/family" />;
  return (
    <>
      <StorageScreen />
      <StatusBarScrim />
    </>
  );
}
