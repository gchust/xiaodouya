const { withMainActivity } = require('expo/config-plugins');

const ANCHOR = 'class MainActivity : ReactActivity() {';
const METHOD = `
  // 系统回收进程后 Activity 记录还在：重建时 getIntent() 还是最初从桌面打开的那个，
  // 链接只通过 onNewIntent 送来，而这时 JS 还没开始监听，链接就丢了（小工具点进来就是这样）。
  // 存下来，Linking.getInitialURL() 才能在恢复后取到。
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
  }
`;

function addOnNewIntent(source) {
  if (source.includes('setIntent(intent)')) return source;
  if (!source.includes(ANCHOR)) {
    // 模板变了要立刻知道：否则构建能过，小工具的链接却悄悄失效。
    throw new Error('MainActivity 的模板变了，with-latest-intent 找不到插入位置');
  }
  const withMethod = source.replace(ANCHOR, `${ANCHOR}${METHOD}`);
  return withMethod.includes('import android.content.Intent')
    ? withMethod
    : withMethod.replace(
        'import android.os.Bundle',
        'import android.content.Intent\nimport android.os.Bundle',
      );
}

const withLatestIntent = (config) =>
  withMainActivity(config, (mod) => {
    if (mod.modResults.language !== 'kt') {
      throw new Error('with-latest-intent 只支持 Kotlin 的 MainActivity');
    }
    mod.modResults.contents = addOnNewIntent(mod.modResults.contents);
    return mod;
  });

module.exports = withLatestIntent;
module.exports.addOnNewIntent = addOnNewIntent;
