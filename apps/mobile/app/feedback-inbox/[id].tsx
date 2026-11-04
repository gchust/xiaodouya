import { useLocalSearchParams } from 'expo-router';
import { FeedbackDetailScreen } from '../../src/screens/FeedbackInboxScreen';
import { StatusBarScrim } from '../../src/ui/StatusBarScrim';

export default function FeedbackDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <FeedbackDetailScreen id={id} />
      <StatusBarScrim />
    </>
  );
}
