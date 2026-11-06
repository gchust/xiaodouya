import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../src/lib/app';
import { useTheme } from '../src/lib/themePref';
import { UpdateWatcher } from '../src/lib/UpdateWatcher';
import { UploadCard } from '../src/lib/UploadCard';
import { colors, fonts } from '../src/theme';
import { FeedbackProvider, SheetProvider } from '../src/ui/overlays';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  // 换主题时这里重新渲染根视图的底色和状态栏；下面的界面由 AppProvider 重新挂载。
  const theme = useTheme();
  const [loaded] = useFonts({
    [fonts.serifMedium]: require('../assets/fonts/NotoSerifSC-Medium.subset.ttf'),
    [fonts.serifBold]: require('../assets/fonts/NotoSerifSC-Bold.subset.ttf'),
    [fonts.monoRegular]: require('../assets/fonts/DMMono-Regular.ttf'),
    [fonts.monoMedium]: require('../assets/fonts/DMMono-Medium.ttf'),
  });

  useEffect(() => {
    if (loaded) void SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.paper }}>
      <SafeAreaProvider>
        <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
        <FeedbackProvider>
          <AppProvider fallback={<View style={{ flex: 1, backgroundColor: colors.paper }} />}>
            <SheetProvider>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.paper },
                  animation: 'slide_from_right',
                }}
              >
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="storage" />
                <Stack.Screen name="nutrition" />
                <Stack.Screen name="piggy-bank" />
                <Stack.Screen name="resources" />
                <Stack.Screen name="favorites" />
                <Stack.Screen name="doc/[id]" />
                <Stack.Screen name="records" />
                <Stack.Screen name="uploads" />
                <Stack.Screen name="feedback" />
                <Stack.Screen name="feedback-inbox/index" />
                <Stack.Screen name="feedback-inbox/[id]" />
                <Stack.Screen
                  name="feedback-media"
                  options={{ animation: 'fade', contentStyle: { backgroundColor: colors.black } }}
                />
                <Stack.Screen name="widgets" />
                <Stack.Screen name="theme" />
                <Stack.Screen
                  name="viewer"
                  options={{ animation: 'fade', contentStyle: { backgroundColor: colors.black } }}
                />
                <Stack.Screen name="index" options={{ animation: 'none' }} />
              </Stack>
              <UploadCard />
              <UpdateWatcher />
            </SheetProvider>
          </AppProvider>
        </FeedbackProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
