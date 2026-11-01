/**
 * 构建时注入的默认服务器地址。用户也可以在登录页改成自己部署的服务器。
 * 模拟器访问宿主机用 10.0.2.2。
 */
export const DEFAULT_API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8787';

/** E2E 构建里用内置样例代替系统相册，见 e2e/README.md。 */
export const IS_E2E = process.env.EXPO_PUBLIC_E2E === '1';
