// Maestro 的 JS 环境：扮演第二位家人，全程走公开接口。
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
const invite = call('POST', '/v1/invites', admin.token, { role: 'caregiver', label: '妈妈' });
const mom = call('POST', '/v1/auth/register', null, {
  email: `mom-${RUN_ID}@example.test`,
  password: 'correct-horse-2',
  displayName: '妈妈',
});
call('POST', '/v1/invites/accept', mom.token, { code: invite.code });
const id = `11111111-1111-4111-8111-${`000000000000${RUN_ID}`.slice(-12)}`;
call('POST', '/v1/sync', mom.token, {
  cursor: 0,
  changes: [
    {
      id: id,
      collection: 'event',
      data: { type: 'feed', at: Date.now(), ml: 75, byName: '妈妈' },
      deleted: false,
      updatedAt: Date.now(),
    },
  ],
});

// 名字常用 GB2312 以外的字（玥、喆）。字体子集里没有，必须能回退到系统字体，不能显示成方块。
const all = call('POST', '/v1/sync', admin.token, { cursor: 0, changes: [] });
const baby = all.records.filter((r) => r.collection === 'baby')[0];
const renamed = {};
for (const key in baby.data) renamed[key] = baby.data[key];
renamed.name = '玥喆';
call('POST', '/v1/sync', admin.token, {
  cursor: 0,
  changes: [
    { id: baby.id, collection: 'baby', data: renamed, deleted: false, updatedAt: Date.now() },
  ],
});
