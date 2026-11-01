import { useLocalSearchParams } from 'expo-router';
import { DocumentScreen } from '../../src/screens/DocumentScreen';

export default function DocumentRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DocumentScreen id={id} />;
}
