// Maestro 的 JS 环境：管理员发“一起记录”的邀请，新的家人注册并接受，全程走公开接口。
// 顺便确认服务端的边界：看得到用量，看不到存储配置（里面有 Access Key）。
const base = 'http://localhost:8787';
function request(method, path, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return http.request(`${base}${path}`, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function call(method, path, token, body) {
  const res = request(method, path, token, body);
  if (res.status >= 400) throw new Error(`${path} -> ${res.status} ${res.body}`);
  return json(res.body);
}
const admin = call('POST', '/v1/auth/login', null, { email: EMAIL, password: 'correct-horse-1' });
const invite = call('POST', '/v1/invites', admin.token, { role: 'caregiver', label: '阿姨' });
const helper = call('POST', '/v1/auth/register', null, {
  email: `caregiver-${RUN_ID}@example.test`,
  password: 'correct-horse-4',
  displayName: '阿姨',
});
call('POST', '/v1/invites/accept', helper.token, { code: invite.code });
const usage = call('GET', '/v1/storage/usage', helper.token);
if (typeof usage.total !== 'number') throw new Error('一起记录的家人读不到用量');
const config = request('GET', '/v1/storage', helper.token);
if (config.status !== 403) throw new Error(`一起记录的家人读存储配置返回 ${config.status}`);
