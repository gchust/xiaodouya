import { Redirect } from 'expo-router';
import { useApp } from '../src/lib/app';
import { AuthFlow, BabySetup, FamilySetup } from '../src/screens/AuthScreens';
import { SyncingPlaceholder } from '../src/ui/SyncingPlaceholder';

export default function Index() {
  const { sessionState, role } = useApp();
  if (sessionState === 'signedOut') return <AuthFlow />;
  if (sessionState === 'noFamily') return <FamilySetup />;
  if (sessionState === 'syncing') return <SyncingPlaceholder />;
  if (sessionState === 'noBaby') return <BabySetup />;
  return <Redirect href={role === 'viewer' ? '/recall' : '/today'} />;
}
