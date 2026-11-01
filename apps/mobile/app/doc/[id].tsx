import { useLocalSearchParams } from 'expo-router';
import { DocumentScreen } from '../../src/screens/DocumentScreen';

import { StatusBarScrim } from '../../src/ui/StatusBarScrim';

export default function DocumentRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <DocumentScreen id={id} />
      <StatusBarScrim />
    </>
  );
}
