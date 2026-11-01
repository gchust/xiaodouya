import { Redirect } from 'expo-router';
import { useApp } from '../src/lib/app';
import { NutritionScreen } from '../src/screens/NutritionScreen';
import { StatusBarScrim } from '../src/ui/StatusBarScrim';

export default function Nutrition() {
  const { role } = useApp();
  // viewer 本来也读不到这些记录（服务端不下发），这里只是不让它进到一张空页面。
  if (role === 'viewer') return <Redirect href="/" />;
  return (
    <>
      <NutritionScreen />
      <StatusBarScrim />
    </>
  );
}
