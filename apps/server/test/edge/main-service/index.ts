// 只用于 edge-smoke.ts 的 edge-runtime 模式：模拟 Supabase 的路由，用免费版的限制启动用户 Worker。
// 线上的主服务是 Supabase 自己的，这里的限制值抄自它公布的文档，不代表和线上完全一样。
declare const EdgeRuntime: {
  userWorkers: {
    create(options: Record<string, unknown>): Promise<{
      fetch(request: Request, options?: { signal?: AbortSignal }): Promise<Response>;
    }>;
  };
};

Deno.serve(async (request) => {
  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: '/functions/api',
      memoryLimitMb: 256,
      workerTimeoutMs: 150_000,
      cpuTimeSoftLimitMs: 1_000,
      cpuTimeHardLimitMs: 2_000,
      noModuleCache: false,
      forceCreate: false,
      envVars: Object.entries(Deno.env.toObject()),
    });
    return await worker.fetch(request, { signal: request.signal });
  } catch (error) {
    console.error('worker error', error);
    return new Response(JSON.stringify({ workerError: String(error) }), { status: 500 });
  }
});
