// Supabase Edge Function 入口。业务代码和 Docker 部署共用 apps/server/src/app.ts。
// 部署前要先运行 pnpm build:edge 生成 _bundle/server.mjs，见 docs/DEPLOYMENT.md。
import { createEdgeHandler } from './_bundle/server.mjs';

declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void } | undefined;

// 响应返回后 isolate 可能被回收，推送要交给运行环境托管。本地用 deno run 调试时没有这个对象。
const background = (task: Promise<void>): void => {
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(task);
};

// 放在模块顶层：同一个 isolate 的所有请求共用一个数据库客户端。
const handler: (request: Request) => Response | Promise<Response> = createEdgeHandler(
  Deno.env.toObject(),
  background,
);

Deno.serve(handler);
