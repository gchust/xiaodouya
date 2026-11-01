// Maestro 的 JS 环境：管理员发只看权限的邀请，外公注册并接受，全程走公开接口。
// 顺便确认服务端真的拦住了他：App 里藏按钮不算权限。
const base = 'http://localhost:8787';
function call(method, path, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = http.request(`${base}${path}`, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status >= 400) throw new Error(`${path} -> ${res.status} ${res.body}`);
  return json(res.body);
}
const admin = call('POST', '/v1/auth/login', null, { email: EMAIL, password: 'correct-horse-1' });
const invite = call('POST', '/v1/invites', admin.token, { role: 'viewer', label: '外公' });
const viewer = call('POST', '/v1/auth/register', null, {
  email: `viewer-${RUN_ID}@example.test`,
  password: 'correct-horse-3',
  displayName: '外公',
});
const joined = call('POST', '/v1/invites/accept', viewer.token, { code: invite.code });
if (joined.role !== 'viewer') throw new Error(`加入后的角色是 ${joined.role}`);

const pulled = call('POST', '/v1/sync', viewer.token, { cursor: 0, changes: [] });
const leaked = pulled.records.filter(
  (r) => r.collection === 'event' || r.collection === 'document',
);
if (leaked.length > 0) throw new Error(`viewer 读到了 ${leaked.length} 条记录或证件`);
if (!pulled.records.some((r) => r.collection === 'moment')) throw new Error('viewer 读不到回忆');

const id = `22222222-2222-4222-8222-${`000000000000${RUN_ID}`.slice(-12)}`;
const attempt = call('POST', '/v1/sync', viewer.token, {
  cursor: 0,
  changes: [
    {
      id: id,
      collection: 'event',
      data: { type: 'feed', at: Date.now(), ml: 75, byName: '外公' },
      deleted: false,
      updatedAt: Date.now(),
    },
  ],
});
if (!attempt.rejected.some((r) => r.id === id)) throw new Error('viewer 写入没有被拒绝');
