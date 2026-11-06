import { useLocalSearchParams } from 'expo-router';
import { DocumentScreen } from '../../src/screens/DocumentScreen';

import { StatusBarScrim } from '../../src/ui/StatusBarScrim';

export default function DocumentRoute() {
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>();
  return (
    <>
      <DocumentScreen id={id} from={from === 'family' ? 'family' : undefined} />
      <StatusBarScrim />
    </>
  );
}
