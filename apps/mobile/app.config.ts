import type { ConfigContext, ExpoConfig } from 'expo/config';
import { AndroidConfig, withStringsXml } from 'expo/config-plugins';

const version = process.env.APP_VERSION ?? '0.1.0';
const versionCode = Number(process.env.APP_VERSION_CODE ?? 1);
// 小工具上有宝宝的名字和记录。Android 16 QPR2 起第三方小工具默认可以放到锁屏，这里明确不要。
const WIDGET_CATEGORY = 'home_screen|not_keyguard';

/**
 * 手机不是中文时都用英文（和 App 里一样），所以 Android 的默认资源放英文，中文放进 `locales`。
 * `name` 不能直接改成英文：iOS 的工程目录（`ios/app.xcworkspace`）是用它算出来的。
 * 名称和 docs/store 里的草稿保持一致。
 */
const ANDROID_DEFAULT_STRINGS: Record<string, string> = {
  app_name: 'Xiaodouya',
  widget_feed_label: 'Log feed',
  widget_sleep_label: 'Sleep',
  widget_summary_label: 'Today',
};

const withEnglishAndroidDefaults = (expo: ExpoConfig): ExpoConfig =>
  withStringsXml(expo, (strings) => {
    strings.modResults = AndroidConfig.Strings.setStringItem(
      Object.entries(ANDROID_DEFAULT_STRINGS).map(([name, value]) => ({
        $: { name },
        _: value,
      })),
      strings.modResults,
    );
    return strings;
  });

const zhIos = {
  CFBundleDisplayName: '小豆芽',
  NSPhotoLibraryUsageDescription: '选择照片和视频，保存到宝宝的回忆里。',
  NSPhotoLibraryAddUsageDescription: '把宝宝的照片和视频保存到手机相册。',
  NSCameraUsageDescription: '拍摄证件和资料。',
  NSMicrophoneUsageDescription: '录下宝宝的声音，保存到回忆里。',
  NSFaceIDUsageDescription: '验证身份后查看证件夹。',
};
const zhStrings = {
  ios: zhIos,
  android: {
    app_name: '小豆芽',
    widget_feed_label: '记喂奶',
    widget_feedwidget_description: '点一下，按上次的奶量记一次喂奶',
    widget_sleep_label: '睡眠',
    widget_sleepwidget_description: '看宝宝是不是在睡，点一下开始或结束睡眠',
    widget_summary_label: '今日汇总',
    widget_summarywidget_description: '今天喂奶、尿布和睡眠的合计',
  },
};

export default (context: ConfigContext): ExpoConfig =>
  withEnglishAndroidDefaults(appConfig(context));

const appConfig = ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: '小豆芽',
  // iOS 只有 lproj 里有这个语言时才用，其他语言退回 en。`zh-Hans` 这样的系统语言不一定匹配 `zh`，都写上。
  locales: {
    zh: zhStrings,
    'zh-Hans': zhStrings,
    'zh-Hant': zhStrings,
    en: {
      ios: {
        CFBundleDisplayName: 'Xiaodouya',
        NSPhotoLibraryUsageDescription: "Choose photos and videos to save in your baby's memories.",
        NSPhotoLibraryAddUsageDescription:
          "Save your baby's photos and videos to the phone's photo library.",
        NSCameraUsageDescription: 'Take photos of documents.',
        NSMicrophoneUsageDescription: "Record your baby's sounds and save them in memories.",
        NSFaceIDUsageDescription: 'Verify your identity to view documents.',
      },
    },
  },
  slug: 'xiaodouya',
  scheme: 'xiaodouya',
  version,
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  backgroundColor: '#f6f1ea',
  android: {
    package: process.env.ANDROID_PACKAGE ?? 'com.gchust.xiaodouya',
    versionCode,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#c0714f',
    },
    softwareKeyboardLayoutMode: 'resize',
    // 配置了才启用远程推送；没有也能正常构建，见 docs/DEPLOYMENT.md。
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON,
    permissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.CAMERA',
      'android.permission.USE_BIOMETRIC',
    ],
    // expo-media-library 的清单自带这条。只往相册里写，用不到读取权限。
    blockedPermissions: ['android.permission.READ_MEDIA_VISUAL_USER_SELECTED'],
  },
  ios: {
    bundleIdentifier: process.env.IOS_BUNDLE_ID ?? 'com.gchust.xiaodouya',
    supportsTablet: false,
  },
  extra: {
    eas: process.env.EAS_PROJECT_ID ? { projectId: process.env.EAS_PROJECT_ID } : undefined,
  },
  experiments: { typedRoutes: false },
  plugins: [
    'expo-router',
    'expo-sqlite',
    'expo-secure-store',
    'expo-font',
    'expo-video',
    'expo-sharing',
    [
      'expo-splash-screen',
      {
        image: './assets/splash.png',
        imageWidth: 200,
        backgroundColor: '#f6f1ea',
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: "Choose photos and videos to save in your baby's memories.",
        cameraPermission: 'Take photos of documents.',
      },
    ],
    [
      // 必须写在这里：不写的话 Expo 也会按默认值应用这个插件，
      // 声明 READ_MEDIA_IMAGES 等读取权限，上架 Google Play 要单独申报。
      'expo-media-library',
      {
        granularPermissions: [],
        // 这条和上面的 photosPermission 是 iOS 的同一个键，要写成一样，否则会被默认的英文覆盖。
        photosPermission: "Choose photos and videos to save in your baby's memories.",
        savePhotosPermission: "Save your baby's photos and videos to the phone's photo library.",
      },
    ],
    [
      'expo-audio',
      { microphonePermission: "Record your baby's sounds and save them in memories." },
    ],
    ['expo-local-authentication', { faceIDPermission: 'Verify your identity to view documents.' }],
    ['expo-notifications', { color: '#c0714f', icon: './assets/notification-icon.png' }],
    './plugins/with-latest-intent',
    // 只生成 Android 的 receiver 和资源，iOS 上这个插件什么都不做。
    [
      'react-native-android-widget',
      {
        fonts: ['./assets/fonts/NotoSerifSC-Bold.subset.ttf', './assets/fonts/DMMono-Medium.ttf'],
        widgets: [
          {
            name: 'FeedWidget',
            label: '@string/widget_feed_label',
            description: 'Tap to log a feed with the last amount',
            previewImage: './assets/widgets/feed-preview.png',
            minWidth: '110dp',
            minHeight: '110dp',
            targetCellWidth: 2,
            targetCellHeight: 2,
            resizeMode: 'horizontal|vertical',
            // 系统不接受比 30 分钟更短的周期；更及时的刷新靠写入和同步后主动更新。
            updatePeriodMillis: 1_800_000,
            widgetCategory: WIDGET_CATEGORY,
          },
          {
            name: 'SleepWidget',
            label: '@string/widget_sleep_label',
            description: 'See whether your baby is asleep. Tap to start or end sleep',
            previewImage: './assets/widgets/sleep-preview.png',
            minWidth: '110dp',
            minHeight: '110dp',
            targetCellWidth: 2,
            targetCellHeight: 2,
            resizeMode: 'horizontal|vertical',
            updatePeriodMillis: 1_800_000,
            widgetCategory: WIDGET_CATEGORY,
          },
          {
            name: 'SummaryWidget',
            label: '@string/widget_summary_label',
            description: "Today's total feeds, diapers and sleep",
            previewImage: './assets/widgets/summary-preview.png',
            minWidth: '250dp',
            minHeight: '110dp',
            targetCellWidth: 4,
            targetCellHeight: 2,
            resizeMode: 'horizontal|vertical',
            updatePeriodMillis: 1_800_000,
            widgetCategory: WIDGET_CATEGORY,
          },
        ],
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          // 自建服务器和开发环境可能是 http；生产环境请用 https（见部署文档）。
          usesCleartextTraffic: process.env.ANDROID_ALLOW_HTTP !== '0',
          buildArchs: (process.env.ANDROID_ARCHS ?? 'arm64-v8a,x86_64').split(','),
        },
      },
    ],
  ],
});
