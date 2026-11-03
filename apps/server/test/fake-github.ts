/**
 * 假的 GitHub Issues 接口。测试和 E2E 都连它，绝不连真实的 GitHub。
 *
 *   集成测试：import { startFakeGithub } from './fake-github'
 *   E2E 和手动走查：npx tsx apps/server/test/fake-github.ts <端口> <令牌>
 *
 * 控制接口（只有这个桩有）：
 *   GET  /__issues            收到的 issue
 *   POST /__fail?count=2&status=503   接下来几次建 issue 返回这个状态
 *   POST /__reset             清空
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeIssue {
  number: number;
  repo: string;
  title: string;
  body: string;
  /** 请求里的其他字段，应该是空的：不加标签、不指派人。 */
  extra: string[];
  authorization: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeGithub {
  url: string;
  issues: FakeIssue[];
  /** 建 issue 的请求次数，包括失败的。 */
  attempts: number;
  /** 接下来 count 次返回 status。 */
  failNext(count: number, status?: number): void;
  /** 每次请求先等这么久，用来测并发和超时。 */
  delayMs: number;
  close(): Promise<void>;
}

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += String(chunk);
    });
    req.on('end', () => resolve(data));
  });

export async function startFakeGithub(token: string, port = 0): Promise<FakeGithub> {
  let failures = 0;
  let failStatus = 500;
  const state: Omit<FakeGithub, 'url' | 'close' | 'failNext'> = {
    issues: [],
    attempts: 0,
    delayMs: 0,
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/__issues') return send(200, state.issues);
    if (url.pathname === '/__fail' && req.method === 'POST') {
      failures = Number(url.searchParams.get('count') ?? 1);
      failStatus = Number(url.searchParams.get('status') ?? 500);
      return send(200, { ok: true });
    }
    if (url.pathname === '/__reset' && req.method === 'POST') {
      state.issues.length = 0;
      state.attempts = 0;
      failures = 0;
      return send(200, { ok: true });
    }
    const match = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname);
    if (!match || req.method !== 'POST') return send(404, { message: 'Not Found' });
    const raw = await read(req);
    state.attempts += 1;
    if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(401, { message: 'Bad credentials' });
    }
    if (failures > 0) {
      failures -= 1;
      // 真实的 GitHub 错误响应里会回显一些东西，服务端不能把响应体写进日志。
      return send(failStatus, { message: `fake failure echo ${raw.slice(0, 40)}` });
    }
    const body = JSON.parse(raw) as Record<string, unknown>;
    const number = state.issues.length + 1;
    state.issues.push({
      number,
      repo: match[1] ?? '',
      title: String(body.title ?? ''),
      body: String(body.body ?? ''),
      extra: Object.keys(body).filter((k) => k !== 'title' && k !== 'body'),
      authorization: req.headers.authorization,
      headers: req.headers,
    });
    return send(201, {
      number,
      html_url: `https://github.example/${match[1]}/issues/${number}`,
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address() as AddressInfo;
  const fake: FakeGithub = Object.assign(state, {
    url: `http://127.0.0.1:${bound}`,
    failNext(count: number, status = 500) {
      failures = count;
      failStatus = status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return fake;
}

// 直接运行时常驻，给 E2E 和手动走查用。
if (process.argv[1]?.endsWith('fake-github.ts')) {
  const port = Number(process.argv[2] ?? 8790);
  const token = process.argv[3] ?? 'fictional-token';
  const fake = await startFakeGithub(token, port);
  console.log(`假的 GitHub：${fake.url}`);
}
