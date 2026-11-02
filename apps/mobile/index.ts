import 'expo-router/entry';
import { AppRegistry, Platform } from 'react-native';
import { registerWidgetTaskHandler } from 'react-native-android-widget';
import { KEEP_ALIVE_TASK } from './modules/upload-service';
import { startLinkInbox } from './src/widgets/linkInbox';
import { widgetTaskHandler } from './src/widgets/taskHandler';

// 桌面小工具的后台任务可能在没有任何界面时启动，这时只会执行入口文件，
// 不会加载 app/_layout，所以必须在这里注册。
if (Platform.OS === 'android') {
  registerWidgetTaskHandler(widgetTaskHandler);
  startLinkInbox();
  // 有上传时一直挂着，让定时器在后台也走，见 UploadServiceModule。结束由原生层决定，这个 Promise 不用 resolve。
  AppRegistry.registerHeadlessTask(KEEP_ALIVE_TASK, () => () => new Promise(() => {}));
}
