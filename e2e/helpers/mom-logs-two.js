// Maestro 的 JS 环境：妈妈一次同步两条记录，看 App 里的汇总。
// 记成昨天的洗澡：不影响后面流程断言的 24 小时汇总和喂奶估算。
const base = 'http://localhost:8787';
function call(path, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = http.request(`${base}${path}`, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
  });
  if (res.status >= 400) throw new Error(`${path} -> ${res.status} ${res.body}`);
  return json(res.body);
}
const mom = call('/v1/auth/login', null, {
  email: `mom-${RUN_ID}@example.test`,
  password: 'correct-horse-2',
});
const suffix = `000000000000${RUN_ID}`.slice(-12);
const yesterday = Date.now() - 25 * 3600000;
call('/v1/sync', mom.token, {
  cursor: 0,
  changes: [
    {
      id: `22222222-2222-4222-8222-${suffix}`,
      collection: 'event',
      data: { type: 'bath', at: yesterday, byName: '妈妈' },
      deleted: false,
      updatedAt: Date.now(),
    },
    {
      id: `33333333-3333-4333-8333-${suffix}`,
      collection: 'event',
      data: { type: 'bath', at: yesterday + 60000, byName: '妈妈' },
      deleted: false,
      updatedAt: Date.now(),
    },
  ],
});
