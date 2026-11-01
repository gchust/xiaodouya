// 只用于 edge-smoke.ts 的 deno 模式：普通 Deno 没有 EdgeRuntime，用它确认入口真的把后台任务交了出去。
globalThis.EdgeRuntime = {
  waitUntil(task) {
    console.log('[smoke] waitUntil');
    task.then(
      () => console.log('[smoke] background done'),
      () => console.log('[smoke] background rejected'),
    );
  },
};
