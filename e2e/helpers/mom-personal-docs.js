// Maestro 的 JS 环境：流程 05a 里的妈妈（流程 05 加入的、一起记录的家人），全程走公开接口。
// STEP 决定这一步做什么，失败就抛错让流程失败。证件号都是虚构的。
//   share         妈妈建两份自己的证件：驾照给管理员看，医保卡谁都不给
//   check-shared  妈妈能拉到管理员给她看的护照（证件号、文件链接都在）
//   unshare       妈妈删掉给管理员看的驾照（App 里卡片消失，说明这之前的改动都已经同步上去）
//   check-revoked 管理员撤销之后：妈妈只拿到删除标记，证件号不在响应里，文件拿不到链接
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
  return { json: json(res.body), text: res.body };
}
function fail(message) {
  throw new Error(message);
}

const mom = call('POST', '/v1/auth/login', null, {
  email: `mom-${RUN_ID}@example.test`,
  password: 'correct-horse-2',
}).json;
const me = call('GET', '/v1/me', mom.token).json;
const admin = me.members.filter((m) => m.role === 'admin')[0];
if (!admin) fail('找不到管理员');
const suffix = `000000000000${RUN_ID}`.slice(-12);
const sharedId = `33333333-3333-4333-8333-${suffix}`;
const privateId = `44444444-4444-4444-8444-${suffix}`;
const license = {
  name: '驾照',
  number: 'D0000000M',
  files: [],
  owner: me.user.id,
  sharedWith: [admin.userId],
};

function pullAll() {
  const records = {};
  const texts = [];
  let cursor = 0;
  for (let i = 0; i < 50; i++) {
    const page = call('POST', '/v1/sync', mom.token, { cursor: cursor, changes: [] });
    texts.push(page.text);
    page.json.records.forEach((r) => {
      records[r.id] = r;
    });
    cursor = page.json.cursor;
    if (!page.json.hasMore) break;
  }
  return { records: records, text: texts.join('\n') };
}

function adminPassport(all) {
  for (const id in all.records) {
    const r = all.records[id];
    if (r.collection === 'document' && r.data && r.data.owner === admin.userId) return r;
  }
  return null;
}

function canFetch(ids) {
  const items = ids.map((id) => ({ id: id, variant: 'original' }));
  const urls = call('POST', '/v1/media/urls', mom.token, { items: items }).json.urls;
  return urls.filter((u) => u.url !== null).length;
}

if (STEP === 'share') {
  call('POST', '/v1/sync', mom.token, {
    cursor: 0,
    changes: [
      {
        id: sharedId,
        collection: 'document',
        data: license,
        deleted: false,
        updatedAt: Date.now(),
      },
      {
        id: privateId,
        collection: 'document',
        data: {
          name: '医保卡',
          number: 'M0000000K',
          files: [],
          owner: me.user.id,
          sharedWith: [],
        },
        deleted: false,
        updatedAt: Date.now(),
      },
    ],
  });
} else if (STEP === 'check-shared') {
  const doc = adminPassport(pullAll());
  if (!doc || doc.deleted) fail('妈妈没收到管理员给她看的证件');
  if (doc.data.number !== 'P1234567X') fail(`证件号不对：${doc.data.number}`);
  if (doc.data.files.length < 2) fail(`文件不全：${doc.data.files.length}`);
  const ids = doc.data.files.map((f) => f.id);
  if (canFetch(ids) !== ids.length) fail('妈妈拿不到管理员给她看的文件');
  output.adminFiles = ids.join(',');
} else if (STEP === 'unshare') {
  call('POST', '/v1/sync', mom.token, {
    cursor: 0,
    changes: [
      { id: sharedId, collection: 'document', data: license, deleted: true, updatedAt: Date.now() },
    ],
  });
} else if (STEP === 'check-revoked') {
  const all = pullAll();
  if (all.text.indexOf('P1234567X') >= 0) fail('撤销后响应里还有证件号');
  const doc = adminPassport(all);
  if (doc) fail('撤销后还收到了内容');
  const ids = ADMIN_FILES.split(',');
  if (canFetch(ids) !== 0) fail('撤销后还能拿到文件链接');
} else {
  fail(`不认识的 STEP：${STEP}`);
}
