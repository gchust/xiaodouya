// Maestro 的 JS 环境：让 e2e/net-proxy.mjs 断开或恢复 App 到服务端的连接。只有 iOS 用。
const res = http.request(`http://127.0.0.1:18790/${STATE}`, { method: 'POST' });
if (res.status !== 200) throw new Error(`net-proxy -> ${res.status}`);
