import { describe, expect, it } from 'vitest';
import {
  CreateFeedbackRequest,
  cleanFeedbackText,
  describeFeedbackAttachments,
  FEEDBACK_MAX_IMAGE_BYTES,
  FEEDBACK_MAX_VIDEO_BYTES,
  FeedbackDiagnostics,
  feedbackAttachmentLimit,
  feedbackDiagnostics,
  fenceFor,
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
