import { Redirect } from 'expo-router';
import { useApp } from '../src/lib/app';
import { AuthFlow, BabySetup, FamilySetup } from '../src/screens/AuthScreens';

export default function Index() {
  const { sessionState, role } = useApp();
  if (sessionState === 'signedOut') return <AuthFlow />;
  if (sessionState === 'noFamily') return <FamilySetup />;
  if (sessionState === 'noBaby') return <BabySetup />;
  return <Redirect href={role === 'viewer' ? '/recall' : '/today'} />;
}
