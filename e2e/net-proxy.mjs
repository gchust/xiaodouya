// iOS 模拟器没有飞行模式，Maestro 的 setAirplaneMode 在 iOS 上不起作用，而模拟器和宿主机共用网络。
// 所以在 App 和服务端之间放一个 TCP 转发，流程通过控制端口把它“拔掉”。
// App 看到的是服务器连不上，不是系统断网：NetInfo 仍然报告在线，界面不会显示“离线中”。
//
//   监听 8787 → 转发到 18787（真正的服务端）
//   POST http://127.0.0.1:18790/off  断开现有连接，之后的连接立刻被重置
//   POST http://127.0.0.1:18790/on   恢复转发

import { createServer as createHttpServer } from 'node:http';
import { connect, createServer } from 'node:net';

const LISTEN_PORT = Number(process.env.PROXY_PORT ?? 8787);
const TARGET_PORT = Number(process.env.PROXY_TARGET ?? 18787);
const CONTROL_PORT = Number(process.env.PROXY_CONTROL ?? 18790);

let online = true;
const open = new Set();

createServer((client) => {
  if (!online) {
    client.destroy();
    return;
  }
  const upstream = connect(TARGET_PORT, '127.0.0.1');
  const pair = [client, upstream];
  open.add(pair);
  const close = () => {
    open.delete(pair);
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close).on('close', close);
  upstream.on('error', close).on('close', close);
  client.pipe(upstream);
  upstream.pipe(client);
}).listen(LISTEN_PORT, 'localhost');

createHttpServer((req, res) => {
  if (req.method === 'POST' && (req.url === '/off' || req.url === '/on')) {
    online = req.url === '/on';
    if (!online) {
      for (const [client, upstream] of open) {
        client.destroy();
        upstream.destroy();
      }
    }
    console.log(online ? '网络恢复' : '网络断开');
    res.end(online ? 'on' : 'off');
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(CONTROL_PORT, '127.0.0.1');
