import 'expo-router/entry';
import { Platform } from 'react-native';
import { registerWidgetTaskHandler } from 'react-native-android-widget';
import { widgetTaskHandler } from './src/widgets/taskHandler';

// 桌面小工具的后台任务可能在没有任何界面时启动，这时只会执行入口文件，
// 不会加载 app/_layout，所以必须在这里注册。
if (Platform.OS === 'android') registerWidgetTaskHandler(widgetTaskHandler);
