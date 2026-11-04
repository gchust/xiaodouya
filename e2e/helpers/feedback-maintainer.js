// Maestro 的 JS 环境：准备「收到的反馈」的维护者账号，全程走公开接口。
// 维护者的邮箱是固定的：e2e.sh 启动服务端时把它写进 FEEDBACK_VIEWER_EMAILS，那时还没有 RUN_ID。
// 本地的开发数据库跨次保留，上一次留下的同名账号先删掉（输入密码确认的正常删除），再注册、加入这次的家庭。
// 加入成只看回忆的家人：App 登录后有家人页，入口在那里；维护者的权限和家庭角色无关。
// 顺便在接口上确认：管理员不在名单里是 403，维护者看得到这次的反馈，列表里没有提交者的邮箱。
const base = typeof BASE === 'undefined' ? 'http://localhost:8787' : BASE;
const MAINTAINER = 'feedback-maintainer@example.test';
const PASSWORD = 'correct-horse-9';

function call(method, path, token, body, allowed) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = http.request(`${base}${path}`, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status >= 400 && !(allowed && allowed.indexOf(res.status) >= 0)) {
    throw new Error(`${path} -> ${res.status} ${res.body}`);
  }
  return { status: res.status, json: res.body ? json(res.body) : null, body: res.body };
}

const admin = call('POST', '/v1/auth/login', null, { email: EMAIL, password: 'correct-horse-1' });
const adminInbox = call('GET', '/v1/feedback-inbox', admin.json.token, undefined, [403]);
if (adminInbox.status !== 403)
  throw new Error(`不在名单里的管理员应该是 403，实际 ${adminInbox.status}`);

const old = call('POST', '/v1/auth/login', null, { email: MAINTAINER, password: PASSWORD }, [401]);
if (old.status === 200) {
  call('POST', '/v1/me/delete', old.json.token, { password: PASSWORD });
}
const maintainer = call('POST', '/v1/auth/register', null, {
  email: MAINTAINER,
  password: PASSWORD,
  displayName: '维护者',
});
const invite = call('POST', '/v1/invites', admin.json.token, { role: 'viewer', label: '维护者' });
call('POST', '/v1/invites/accept', maintainer.json.token, { code: invite.json.code });

const me = call('GET', '/v1/me', maintainer.json.token);
if (me.json.canViewFeedback !== true) throw new Error('名单里的维护者 canViewFeedback 不是 true');
const inbox = call('GET', '/v1/feedback-inbox?limit=50', maintainer.json.token);
const mine = inbox.json.items.filter((i) => i.text.indexOf(`E2E-${RUN_ID}`) >= 0);
if (mine.length !== 1) throw new Error(`列表里应该正好有 1 条这次的反馈，实际 ${mine.length} 条`);
if (mine[0].attachments.length !== 1 || mine[0].attachments[0].kind !== 'image') {
  throw new Error('这次的反馈应该有 1 张图片');
}
if (inbox.body.indexOf(EMAIL) >= 0) throw new Error('列表里出现了提交者的邮箱');
