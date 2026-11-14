import { useFonts } from 'expo-font';
import { NavigationBar } from 'expo-navigation-bar';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../src/lib/app';
import { reapplyNativeScheme, useTheme } from '../src/lib/themePref';
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
    if (!loaded) return;
    void SplashScreen.hideAsync();
    reapplyNativeScheme();
  }, [loaded]);

  if (!loaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.paper }}>
      <SafeAreaProvider>
        <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
        {/* 三键导航时系统在导航栏下垫一层半透明底，深浅只在启动时按手机定一次（RN 的 enableEdgeToEdge），
            手机浅色、App 深色时屏幕最下面是一条亮带。这里跟着 App 的深浅换（issue #105）。 */}
        <NavigationBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
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
                <Stack.Screen name="trends" />
                <Stack.Screen name="piggy-bank" />
                <Stack.Screen name="resources" />
                <Stack.Screen name="favorites" />
                <Stack.Screen name="doc/[id]" />
                <Stack.Screen name="records" />
                <Stack.Screen name="recall-search" />
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
