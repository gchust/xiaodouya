import type { ConfigContext, ExpoConfig } from 'expo/config';
import { withEntitlementsPlist, withInfoPlist } from 'expo/config-plugins';

const version = process.env.APP_VERSION ?? '0.1.0';
const versionCode = Number(process.env.APP_VERSION_CODE ?? 1);
// 小工具上有宝宝的名字和记录。Android 16 QPR2 起第三方小工具默认可以放到锁屏，这里明确不要。
const WIDGET_CATEGORY = 'home_screen|not_keyguard';

/**
 * 去掉插件默认声明、App 用不到的 iOS 能力。Android 的配置不动。
 * - expo-audio 加的 audio 后台模式：App 不在后台放声音，审核会问为什么要声明。
 * - expo-notifications 加的推送权限：不做远程推送，喂奶提醒是本机通知，用不到它。
 *   留着的话，Bundle ID 必须开通 Push Notifications 才能签名。
 * mod 按添加的相反顺序执行，plugins 里的比这里添加得晚，所以这一步在那些插件之后运行。
 */
const withoutUnusedIosCapabilities = (expo: ExpoConfig): ExpoConfig =>
  withEntitlementsPlist(
    withInfoPlist(expo, (plist) => {
      const modes = plist.modResults.UIBackgroundModes?.filter((mode) => mode !== 'audio');
      if (modes?.length) plist.modResults.UIBackgroundModes = modes;
      else delete plist.modResults.UIBackgroundModes;
      return plist;
    }),
    (entitlements) => {
      delete entitlements.modResults['aps-environment'];
      return entitlements;
    },
  );

export default (context: ConfigContext): ExpoConfig =>
  withoutUnusedIosCapabilities(appConfig(context));

const appConfig = ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: '小豆芽',
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
    buildNumber: String(versionCode),
    supportsTablet: false,
    config: {
      // 只用系统的 HTTPS 和哈希，属于出口合规的豁免范围。不写的话每次上传 TestFlight 都要手动回答一遍。
      usesNonExemptEncryption: false,
    },
    privacyManifests: {
      // Apple 要求声明调用“需要说明理由的 API”的原因，缺了上传后会收到邮件，App Store 审核不通过。
      // 分类和理由的定义：https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype
      // Expo 的做法：https://docs.expo.dev/guides/apple-privacy/
      // 静态链接的 Pod 里的清单 Apple 不一定解析得到（Expo 文档如此说明），所以按 node_modules 里各依赖的
      // PrivacyInfo.xcprivacy 再声明一遍。0A2A.1 只能由第三方 SDK 声明，App 不写。
      // 升级依赖后要重新对照，scripts/ios-build.sh 的日志里有合并后的结果。
      NSPrivacyTracking: false,
      NSPrivacyAccessedAPITypes: [
        {
          // 文件的时间和大小。C617.1：App 容器内的文件（RN、expo-file-system、录音、视频缓存）。
          // 3B52.1：用户通过文档选择器授权的文件（expo-document-picker、expo-file-system）。
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          NSPrivacyAccessedAPITypeReasons: ['C617.1', '3B52.1'],
        },
        {
          // 开机时长。35F9.1：计算 App 内事件之间的间隔（RN 的计时）。
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
          NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
        },
        {
          // 磁盘空间。E174.1：写文件前看空间够不够。App 自己不调用，但 expo-file-system 把这个 API 编进了 App。
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
          NSPrivacyAccessedAPITypeReasons: ['E174.1'],
        },
        {
          // UserDefaults。CA92.1：只读写 App 自己的数据（RN、expo-constants、expo-notifications 等）。
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
        },
      ],
    },
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
        photosPermission: '选择照片和视频，保存到宝宝的回忆里。',
        cameraPermission: '拍摄证件和资料。',
      },
    ],
    [
      // 必须写在这里：不写的话 Expo 也会按默认值应用这个插件，
      // 声明 READ_MEDIA_IMAGES 等读取权限，上架 Google Play 要单独申报。
      'expo-media-library',
      {
        granularPermissions: [],
        // 这条和上面的 photosPermission 是 iOS 的同一个键，要写成一样，否则会被默认的英文覆盖。
        photosPermission: '选择照片和视频，保存到宝宝的回忆里。',
        savePhotosPermission: '把宝宝的照片和视频保存到手机相册。',
      },
    ],
    ['expo-audio', { microphonePermission: '录下宝宝的声音，保存到回忆里。' }],
    ['expo-local-authentication', { faceIDPermission: '验证身份后查看证件夹。' }],
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
            label: '记喂奶',
            description: '点一下，按上次的奶量记一次喂奶',
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
            label: '睡眠',
            description: '看宝宝是不是在睡，点一下开始或结束睡眠',
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
            label: '今日汇总',
            description: '今天喂奶、尿布和睡眠的合计',
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
