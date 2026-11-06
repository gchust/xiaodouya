const { withAndroidManifest } = require('expo/config-plugins');

const NAME = 'expo.modules.sharetargets.E2eShareTargetActivity';

/**
 * 只在 E2E 构建里登记一个能收文字分享的 Activity（F-139）。CI 的模拟器上没有任何聊天 App，
 * “装了才显示”和“点了直接打开”要有一个一定在的目标；App 自己最稳定，不用另装 APK。
 * 正式构建不应用这个插件，见 app.config.ts。
 */
function addE2eShareTarget(manifest) {
  const app = manifest.manifest.application?.[0];
  if (!app) throw new Error('清单里没有 application');
  app.activity = (app.activity ?? []).filter((activity) => activity.$['android:name'] !== NAME);
  app.activity.push({
    $: {
      'android:name': NAME,
      'android:exported': 'true',
      'android:label': 'E2E share target',
      'android:theme': '@android:style/Theme.Material.Light.NoActionBar',
    },
    'intent-filter': [
      {
        action: [{ $: { 'android:name': 'android.intent.action.SEND' } }],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
        data: [{ $: { 'android:mimeType': 'text/plain' } }],
      },
    ],
  });
  return manifest;
}

const withE2eShareTarget = (config) =>
  withAndroidManifest(config, (mod) => {
    mod.modResults = addE2eShareTarget(mod.modResults);
    return mod;
  });

module.exports = withE2eShareTarget;
module.exports.addE2eShareTarget = addE2eShareTarget;
