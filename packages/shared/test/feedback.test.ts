import { describe, expect, it } from 'vitest';
import {
  CreateFeedbackRequest,
  cleanFeedbackText,
  describeFeedbackAttachments,
  expiredAttachmentCount,
  FEEDBACK_MAX_IMAGE_BYTES,
  FEEDBACK_MAX_VIDEO_BYTES,
  FEEDBACK_PUBLIC_TOKEN,
  FeedbackDiagnostics,
  FeedbackInboxQuery,
  feedbackAttachmentFileName,
  feedbackAttachmentKind,
  feedbackAttachmentLimit,
  feedbackDiagnostics,
  fenceFor,
  publicFeedbackMime,
  renderFeedbackIssue,
} from '../src/feedback';

const id = '0b6f2f4e-3c1d-4a8b-9e7f-1234567890ab';
const diagnostics = {
  appVersion: '0.3.3',
  os: 'android',
  osVersion: '15',
  locale: 'zh',
  region: 'SG',
} as const;

/** 代码块之外的部分。用户写的东西只能出现在代码块里。 */
function outsideFence(body: string, fence: string): string {
  const start = body.indexOf(`${fence}text\n`);
  const end = body.indexOf(`\n${fence}\n`, start + fence.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return body.slice(0, start) + body.slice(end + fence.length + 2);
}

/** 按 CommonMark 找代码块在哪一行结束：一行只有反引号、且不比开始的短。 */
function fenceClosesAt(body: string, fence: string): number {
  const lines = body.split('\n');
  const open = lines.indexOf(`${fence}text`);
  for (let i = open + 1; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,})\s*$/.exec(lines[i] ?? '');
    if (m && (m[1]?.length ?? 0) >= fence.length) return i;
  }
  return -1;
}

describe('反馈的 issue 正文', () => {
  it('@提及、#引用、图片、链接和 HTML 都在代码块里', () => {
    const text =
      '@octocat 看看 #12 和 gchust/xiaodouya#3\n![x](https://evil.example/a.png)\n<img src=x>\nhttps://evil.example';
    const { title, body } = renderFeedbackIssue({ id, text, diagnostics, attachments: [] });
    const fence = fenceFor(cleanFeedbackText(text));
    const outside = outsideFence(body, fence);
    for (const bad of ['@octocat', '#12', 'xiaodouya#3', '![x]', '<img', 'evil.example']) {
      expect(body).toContain(bad);
      expect(outside).not.toContain(bad);
      expect(title).not.toContain(bad);
    }
  });

  it('用户写了反引号也关不上代码块', () => {
    for (const text of ['```\n@octocat\n```', '````\n#1\n````', 'a ``` b\n```````\n![x](y)']) {
      const { body } = renderFeedbackIssue({ id, text, diagnostics, attachments: [] });
      const fence = fenceFor(cleanFeedbackText(text));
      expect(fence.length).toBeGreaterThan(
        Math.max(...(text.match(/`+/g) ?? ['']).map((m) => m.length)),
      );
      const lines = body.split('\n');
      const closes = fenceClosesAt(body, fence);
      // 关闭的那一行就是我们自己写的围栏，后面紧跟着表格。
      expect(lines[closes]).toBe(fence);
      expect(lines.slice(closes + 1).join('\n')).not.toMatch(/@octocat|#1\b|!\[x\]/);
    }
  });

  it('只有反馈 id、诊断信息、附件个数类型和大小，没有附件的地址', () => {
    const { title, body } = renderFeedbackIssue({
      id,
      text: '保存照片后闪退',
      diagnostics,
      attachments: [
        { mime: 'image/jpeg', size: 1_200_000 },
        { mime: 'video/mp4', size: 8_400_000 },
      ],
    });
    expect(title).toBe('App 反馈 0b6f2f4e · android 0.3.3');
    expect(body).toContain(`\`${id}\``);
    expect(body).toContain('`0.3.3`');
    expect(body).toContain('`android 15`');
    expect(body).toContain('`zh`');
    expect(body).toContain('`SG`');
    expect(body).toContain('2 个（图片 1.1 MB，视频 8.0 MB）');
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toMatch(/feedback\//);
  });

  it('没有地区和附件时也写清楚', () => {
    const { body } = renderFeedbackIssue({
      id,
      text: 'x',
      diagnostics: { ...diagnostics, region: undefined },
      attachments: [],
    });
    expect(body).toContain('| 地区 | — |');
    expect(body).toContain('| 附件 | 没有 |');
  });
});

describe('同意公开的附件（F-126）', () => {
  const base = 'https://api.fictional.test/functions/v1/api/v1/public/feedback-files';
  const token = (c: string) => c.repeat(43);

  it('图片嵌入、视频写成链接，各自编号，写明保留期和缓存', () => {
    const { body } = renderFeedbackIssue({
      id,
      text: '保存照片后闪退',
      diagnostics,
      attachments: [
        { mime: 'image/jpeg', size: 1_200_000, url: `${base}/${token('a')}` },
        { mime: 'video/mp4', size: 8_400_000, url: `${base}/${token('b')}` },
        { mime: 'image/png', size: 300_000, url: `${base}/${token('c')}` },
      ],
      attachmentDays: 90,
    });
    expect(body).toContain('3 个（图片 1.1 MB，视频 8.0 MB，图片 293 KB），3 个公开在下面');
    expect(body).toContain(`![图片 1（1.1 MB）](${base}/${token('a')})`);
    expect(body).toContain(`![图片 2（293 KB）](${base}/${token('c')})`);
    const video = body.split('\n').find((l) => l.includes(token('b')));
    expect(video).toBe(`[视频 1（8.0 MB）](${base}/${token('b')})`);
    expect(body).toContain('90 天后删除');
    expect(body).toContain('缓存');
    // 公开链接都在用户文字的代码块外面，用户写的东西还在代码块里。
    const fence = fenceFor('保存照片后闪退');
    expect(outsideFence(body, fence)).toContain('![图片 1');
  });

  it('没有链接的附件照旧只写个数；部分公开时写清楚几个不公开', () => {
    const legacy = renderFeedbackIssue({
      id,
      text: 'x',
      diagnostics,
      attachments: [{ mime: 'image/jpeg', size: 100, url: null }],
      attachmentDays: 90,
    }).body;
    expect(legacy).toContain('只在服务端的私有存储里，不公开');
    expect(legacy).not.toContain('### 附件');
    expect(legacy).not.toMatch(/https?:\/\//);
    const mixed = describeFeedbackAttachments([
      { mime: 'image/svg+xml', size: 100 },
      { mime: 'image/jpeg', size: 100, url: `${base}/${token('d')}` },
    ]);
    expect(mixed).toBe('2 个（图片 1 KB，图片 1 KB），1 个公开在下面，1 个不公开');
  });

  it('只有常见的图片和视频格式能公开，类型统一成小写', () => {
    expect(publicFeedbackMime('IMAGE/JPEG')).toBe('image/jpeg');
    expect(publicFeedbackMime('image/jpg')).toBe('image/jpeg');
    expect(publicFeedbackMime('video/mp4; codecs=avc1')).toBe('video/mp4');
    for (const mime of ['image/svg+xml', 'image/heic', 'text/html', 'video/x-matroska']) {
      expect(publicFeedbackMime(mime)).toBeNull();
    }
  });

  it('同意公开是可选字段：旧版 App 不发，发了只能是布尔值', () => {
    const body = {
      id,
      text: 'x',
      diagnostics,
      attachments: [],
    };
    expect(CreateFeedbackRequest.parse(body).publicAttachments).toBeUndefined();
    expect(
      CreateFeedbackRequest.parse({ ...body, publicAttachments: true }).publicAttachments,
    ).toBe(true);
    expect(CreateFeedbackRequest.safeParse({ ...body, publicAttachments: 'yes' }).success).toBe(
      false,
    );
    expect(FEEDBACK_PUBLIC_TOKEN.test(token('A'))).toBe(true);
    expect(FEEDBACK_PUBLIC_TOKEN.test(`${token('A')}=`)).toBe(false);
    expect(FEEDBACK_PUBLIC_TOKEN.test(id)).toBe(false);
  });
});

describe('反馈的文字', () => {
  const rlo = String.fromCharCode(0x202e);
  const zwsp = String.fromCharCode(0x200b);
  const zwj = String.fromCharCode(0x200d);
  const nul = String.fromCharCode(0);

  it('换行统一，去掉控制字符、双向控制符和首尾空白，表情的连接符留着', () => {
    expect(cleanFeedbackText(`  a\r\nb\rc${nul}${rlo}d${zwsp}e  `)).toBe('a\nb\ncde');
    const family = `\u{1F468}${zwj}\u{1F469}`;
    expect(cleanFeedbackText(family)).toBe(family);
  });

  it('只有空白的反馈不收', () => {
    const base = { id, diagnostics, attachments: [] };
    expect(CreateFeedbackRequest.safeParse({ ...base, text: `  \n${zwsp} ` }).success).toBe(false);
    expect(CreateFeedbackRequest.safeParse({ ...base, text: '闪退了' }).success).toBe(true);
    expect(CreateFeedbackRequest.safeParse({ ...base, text: 'x'.repeat(4001) }).success).toBe(
      false,
    );
  });

  it('附件最多 5 个', () => {
    const attachment = () => ({ id: crypto.randomUUID(), mime: 'image/png', size: 10 });
    const parse = (n: number) =>
      CreateFeedbackRequest.safeParse({
        id,
        text: 'x',
        diagnostics,
        attachments: Array.from({ length: n }, attachment),
      }).success;
    expect(parse(5)).toBe(true);
    expect(parse(6)).toBe(false);
  });
});

describe('诊断信息进公开页面前要卡死格式', () => {
  it('正常的值通过', () => {
    expect(FeedbackDiagnostics.safeParse(diagnostics).success).toBe(true);
    expect(
      FeedbackDiagnostics.safeParse({
        ...diagnostics,
        appVersion: '1.0.0-rc.1+42',
        os: 'ios',
        osVersion: '18.1',
      }).success,
    ).toBe(true);
    expect(FeedbackDiagnostics.safeParse({ ...diagnostics, region: 'OTHER' }).success).toBe(true);
  });

  it('带反引号、空格、邮箱、链接、换行的都拒绝', () => {
    for (const patch of [
      { appVersion: '1.0`|x' },
      { appVersion: 'a b' },
      { osVersion: 'me@example.test' },
      { osVersion: 'http://x' },
      { osVersion: '15\n@octocat' },
      { region: 'sg' },
      { region: 'Singapore' },
      { locale: 'fr' },
      { os: 'windows' },
    ]) {
      expect(FeedbackDiagnostics.safeParse({ ...diagnostics, ...patch }).success).toBe(false);
    }
  });
});

describe('附件', () => {
  it('只收图片和视频，各有上限', () => {
    expect(feedbackAttachmentLimit('image/jpeg')).toBe(FEEDBACK_MAX_IMAGE_BYTES);
    expect(feedbackAttachmentLimit('VIDEO/MP4')).toBe(FEEDBACK_MAX_VIDEO_BYTES);
    expect(feedbackAttachmentLimit('application/pdf')).toBeNull();
    expect(feedbackAttachmentLimit('audio/m4a')).toBeNull();
  });

  it('描述里没有文件名', () => {
    expect(describeFeedbackAttachments([])).toBe('没有');
    expect(describeFeedbackAttachments([{ mime: 'image/png', size: 2048 }])).toBe(
      '1 个（图片 2 KB），只在服务端的私有存储里，不公开',
    );
  });
});

describe('手机上读到的诊断信息', () => {
  it('格式不对的写成 unknown，不让整条反馈发不出去', () => {
    const d = feedbackDiagnostics({
      appVersion: '0.3.3 (build 7)',
      os: 'android',
      osVersion: 35,
      locale: 'en',
      region: 'Singapore',
    });
    expect(d).toEqual({ appVersion: 'unknown', os: 'android', osVersion: '35', locale: 'en' });
    expect(FeedbackDiagnostics.safeParse(d).success).toBe(true);
  });

  it('不认识的系统算 other，没有家庭就没有地区', () => {
    const d = feedbackDiagnostics({
      appVersion: '0.3.3',
      os: 'web',
      osVersion: null,
      locale: 'zh',
      region: undefined,
    });
    expect(d).toEqual({ appVersion: '0.3.3', os: 'other', osVersion: 'unknown', locale: 'zh' });
  });
});

describe('维护者查看收到的反馈', () => {
  it('issue 里说可以在 App 里看附件，但没有任何能打开附件的东西', () => {
    const { body } = renderFeedbackIssue({
      id,
      text: '闪退',
      diagnostics,
      attachments: [{ mime: 'image/jpeg', size: 3_200_000 }],
    });
    const line = body.split('\n').find((l) => l.startsWith('维护者查看附件'));
    expect(line).toBe(
      `维护者查看附件：\`cli feedback ${id}\`（签名链接 10 分钟有效），或在 App 的「收到的反馈」里查看。`,
    );
    expect(body).not.toMatch(/https?:|xiaodouya:\/\/|feedback\//);
  });

  it('下载的文件名是附件 id 加扩展名，不认识的类型也不会带出奇怪的字符', () => {
    const a = '11111111-2222-4333-8444-555555555555';
    expect(feedbackAttachmentFileName(a, 'image/jpeg')).toBe(`${a}.jpg`);
    expect(feedbackAttachmentFileName(a, 'IMAGE/PNG')).toBe(`${a}.png`);
    expect(feedbackAttachmentFileName(a, 'video/quicktime')).toBe(`${a}.mov`);
    expect(feedbackAttachmentFileName(a, 'video/mp4; codecs=avc1')).toBe(`${a}.mp4`);
    expect(feedbackAttachmentFileName(a, 'image/x-portable-bitmap')).toBe(`${a}.portable`);
    expect(feedbackAttachmentFileName(a, 'image/../../etc')).toBe(`${a}.bin`);
    expect(feedbackAttachmentFileName(a, 'weird')).toBe(`${a}.bin`);
  });

  it('附件类型只分照片和视频', () => {
    expect(feedbackAttachmentKind('video/mp4')).toBe('video');
    expect(feedbackAttachmentKind('VIDEO/quicktime')).toBe('video');
    expect(feedbackAttachmentKind('image/heic')).toBe('image');
  });

  it('提交时的附件比现在多，就是过了保留期删掉了', () => {
    const att = { id, mime: 'image/jpeg', size: 1, kind: 'image' as const };
    expect(expiredAttachmentCount({ attachmentCount: 2, attachments: [att] })).toBe(1);
    expect(expiredAttachmentCount({ attachmentCount: 1, attachments: [att] })).toBe(0);
    expect(expiredAttachmentCount({ attachmentCount: 0, attachments: [] })).toBe(0);
  });

  it('游标格式卡死，页大小有上限', () => {
    expect(FeedbackInboxQuery.safeParse({ before: `1767225600123456_${id}` }).success).toBe(true);
    expect(FeedbackInboxQuery.safeParse({ before: 'garbage' }).success).toBe(false);
    expect(FeedbackInboxQuery.safeParse({ before: `1_${id}'--` }).success).toBe(false);
    expect(FeedbackInboxQuery.parse({ limit: '5' }).limit).toBe(5);
    expect(FeedbackInboxQuery.safeParse({ limit: '51' }).success).toBe(false);
    expect(FeedbackInboxQuery.safeParse({ limit: '0' }).success).toBe(false);
  });
});
