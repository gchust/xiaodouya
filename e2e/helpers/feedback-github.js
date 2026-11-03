// Maestro 的 JS 环境：操作 e2e.sh 启动的假 GitHub（apps/server/test/fake-github.ts），绝不连真实的 GitHub。
// ACTION=fail：下一次建 issue 返回 502。ACTION=check：核对刚收到的 issue。
const base = 'http://localhost:8790';

if (ACTION === 'fail') {
  const res = http.request(`${base}/__fail?count=1&status=502`, { method: 'POST', body: '' });
  if (res.status !== 200) throw new Error(`假 GitHub 没响应：${res.status}`);
} else {
  const res = http.request(`${base}/__issues`, { method: 'GET' });
  if (res.status !== 200) throw new Error(`假 GitHub 没响应：${res.status}`);
  const issues = json(res.body).filter((i) => i.body.indexOf(`E2E-${RUN_ID}`) >= 0);
  if (issues.length !== 1) throw new Error(`应该正好有 1 个这次的 issue，实际 ${issues.length} 个`);
  const body = issues[0].body;
  const lines = body.split('\n');
  const open = lines.findIndex((l) => /^`{3,}text$/.test(l));
  if (open < 0) throw new Error('用户的文字没有放进代码块');
  const fence = lines[open].replace('text', '');
  const close = lines.indexOf(fence, open + 1);
  const inside = lines.slice(open + 1, close).join('\n');
  const outside = lines.slice(0, open).concat(lines.slice(close + 1)).join('\n');
  if (inside.indexOf('@octocat') < 0) throw new Error('代码块里应该有用户写的 @octocat');
  if (outside.indexOf('@octocat') >= 0 || /#1\b/.test(outside)) {
    throw new Error('@提及或 #引用跑到了代码块外面');
  }
  if (body.indexOf(EMAIL) >= 0) throw new Error('issue 里出现了账号邮箱');
  if (body.indexOf('feedback/') >= 0 || body.indexOf('X-Amz') >= 0) {
    throw new Error('issue 里出现了附件的地址');
  }
  if (body.indexOf('1 个（图片') < 0) throw new Error('issue 里应该写着有 1 张图片');
}
