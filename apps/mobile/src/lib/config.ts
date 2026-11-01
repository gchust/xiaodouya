/**
 * 构建时注入的默认服务器地址。用户也可以在登录页改成自己部署的服务器。
 * Android 模拟器访问宿主机用 10.0.2.2；iOS 模拟器和宿主机共用网络，用 localhost。
 */
export const DEFAULT_API_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (process.env.EXPO_OS === 'ios' ? 'http://localhost:8787' : 'http://10.0.2.2:8787');

/** 用户协议和隐私政策的地址，构建时注入。没有设置时注册页不提这份文件。 */
export const TERMS_URL = process.env.EXPO_PUBLIC_TERMS_URL || null;
export const PRIVACY_URL = process.env.EXPO_PUBLIC_PRIVACY_URL || null;

/** E2E 构建里用内置样例代替系统相册，见 e2e/README.md。 */
export const IS_E2E = process.env.EXPO_PUBLIC_E2E === '1';
