import { z } from 'zod';
import { formatBytes } from './domain/age';
import { locales } from './i18n/locale';

/**
 * 用户反馈：App 里写的文字会发到 GitHub 的 issue（通常是公开仓库），附件只放服务端的私有存储。
 * issue 正文由这里生成，App 也用同一份诊断信息给用户看“会公开什么”。
 */

export const FEEDBACK_MAX_TEXT = 4000;
export const FEEDBACK_MAX_ATTACHMENTS = 5;
export const FEEDBACK_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 附件走单个 PUT，不分片；更大的视频在慢网上很难一次传完，反馈用不着那么长。 */
export const FEEDBACK_MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** 这种附件最大多少字节。不收的类型返回 null。 */
export function feedbackAttachmentLimit(mime: string): number | null {
  const lower = mime.toLowerCase();
  if (lower.startsWith('image/')) return FEEDBACK_MAX_IMAGE_BYTES;
  if (lower.startsWith('video/')) return FEEDBACK_MAX_VIDEO_BYTES;
  return null;
}

export const feedbackPlatforms = ['android', 'ios', 'other'] as const;

/**
 * 诊断信息原样进公开的 issue，所以每个字段都用正则卡死：没有空格以外的标点组合、没有反引号、
 * 也放不下邮箱或链接。不是用户写的话，不需要转义，校验不过就整个请求拒绝。
 */
export const FeedbackDiagnostics = z.object({
  appVersion: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/),
  os: z.enum(feedbackPlatforms),
  osVersion: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/),
  locale: z.enum(locales),
  /** 家庭的地区（SG、CN、US、OTHER）。没有家庭时不填。 */
  region: z
    .string()
    .regex(/^(?:[A-Z]{2}|OTHER)$/)
    .optional(),
});
export type FeedbackDiagnostics = z.infer<typeof FeedbackDiagnostics>;

/**
 * 手机上读到的值不一定符合上面的格式（比如厂商改过的版本号）。读不懂的写成 unknown，
 * 反馈照样能发，也不会把奇怪的字符串带进公开页面。
 */
export function feedbackDiagnostics(raw: {
  appVersion: string | null | undefined;
  os: string;
  osVersion: string | number | null | undefined;
  locale: (typeof locales)[number];
  region: string | null | undefined;
}): FeedbackDiagnostics {
  const shape = FeedbackDiagnostics.shape;
  const pick = (schema: z.ZodType<string>, value: unknown) => {
    const parsed = schema.safeParse(typeof value === 'number' ? String(value) : value);
    return parsed.success ? parsed.data : 'unknown';
  };
  const os = shape.os.safeParse(raw.os);
  const region = shape.region.safeParse(raw.region ?? undefined);
  return {
    appVersion: pick(shape.appVersion, raw.appVersion),
    os: os.success ? os.data : 'other',
    osVersion: pick(shape.osVersion, raw.osVersion),
    locale: raw.locale,
    ...(region.success && region.data ? { region: region.data } : {}),
  };
}

export const FeedbackAttachmentInput = z.object({
  id: z.uuid(),
  mime: z.string().min(1).max(120),
  size: z.number().int().positive(),
});
export type FeedbackAttachmentInput = z.infer<typeof FeedbackAttachmentInput>;

/**
 * 第一步：建草稿并拿附件的上传链接。同一个 id 再调一次是幂等的：草稿可以改文字和附件，
 * 已经提交的原样返回状态。这样手机断网重试不会多出一条反馈。
 */
export const CreateFeedbackRequest = z.object({
  id: z.uuid(),
  text: z
    .string()
    .max(FEEDBACK_MAX_TEXT)
    .refine((v) => cleanFeedbackText(v).length > 0, { message: 'empty' }),
  diagnostics: FeedbackDiagnostics,
  attachments: z.array(FeedbackAttachmentInput).max(FEEDBACK_MAX_ATTACHMENTS),
});
export type CreateFeedbackRequest = z.infer<typeof CreateFeedbackRequest>;

/** draft：附件还没传完；queued：等着建 issue（GitHub 暂时不可用时会停在这里，服务端自动重试）；sent：issue 已建好。 */
export const feedbackStatuses = ['draft', 'queued', 'sent'] as const;
export type FeedbackStatus = (typeof feedbackStatuses)[number];

export interface FeedbackUploadTarget {
  id: string;
  url: string;
  headers: Record<string, string>;
  expiresIn: number;
}

export interface CreateFeedbackResponse {
  id: string;
  status: FeedbackStatus;
  /** 还没传完的附件的上传链接。已经传好的不在里面。 */
  uploads: FeedbackUploadTarget[];
}

export interface FeedbackView {
  id: string;
  status: FeedbackStatus;
  createdAt: number;
  /** 文字的开头，App 的列表用。 */
  excerpt: string;
  attachments: number;
}

export interface FeedbackListResponse {
  items: FeedbackView[];
}

/** 服务器的反馈能力，放在公开的 /v1/config 里。旧服务器没有这个字段，App 当作不可用。 */
export interface FeedbackConfig {
  enabled: boolean;
  /** 反馈发到的仓库是公开的（部署者配置，不确定时按公开）。App 据此提醒“文字会公开”。 */
  public: boolean;
  /** 服务器有平台存储才能收附件。 */
  attachments: boolean;
  /** 附件在 issue 建好后保留多少天，null 表示一直保留。 */
  attachmentDays: number | null;
}

// 双向文字控制符能让显示的顺序和实际内容不一样（GitHub 也会为此警告）。零宽连接符不去掉：表情和一些文字要用。
const INVISIBLE = /[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
// 制表和换行以外的控制字符。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要去掉控制字符。
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** 换行统一、去掉控制字符和看不见的字符、去掉首尾空白。服务端存的和发到 GitHub 的都是这个结果。 */
export function cleanFeedbackText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(INVISIBLE, '').trim();
}

/**
 * 用户的文字整段放进代码块：块里的 @提及不通知人，#123 和链接不变成引用，图片和 HTML 不渲染。
 * 围栏比文字里最长的一串反引号还长，用户写什么都关不上它（CommonMark：关闭的围栏不能比开始的短）。
 */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const kindName = (mime: string) => (mime.toLowerCase().startsWith('video/') ? '视频' : '图片');

/** 附件只写个数、类型和大小。文件名可能带名字，不写。 */
export function describeFeedbackAttachments(
  attachments: readonly { mime: string; size: number }[],
): string {
  if (attachments.length === 0) return '没有';
  const parts = attachments.map((a) => `${kindName(a.mime)} ${formatBytes(a.size)}`);
  return `${attachments.length} 个（${parts.join('，')}），只在服务端的私有存储里，不公开`;
}

export interface FeedbackIssueInput {
  id: string;
  text: string;
  diagnostics: FeedbackDiagnostics;
  attachments: readonly { mime: string; size: number }[];
}

/**
 * issue 的标题和正文。这里能出现的只有：用户写的文字（在代码块里）、反馈 id、诊断信息（正则校验过）、
 * 附件的类型和大小。邮箱、账号、家庭、宝宝的信息和附件的地址都不在输入里，也就写不进去。
 * 标题不放用户的文字，省得要考虑标题里的提及和引用。
 */
export function renderFeedbackIssue(input: FeedbackIssueInput): { title: string; body: string } {
  const text = cleanFeedbackText(input.text);
  const d = input.diagnostics;
  const fence = fenceFor(text);
  const title = `App 反馈 ${input.id.slice(0, 8)} · ${d.os} ${d.appVersion}`;
  const body = [
    '<!-- xiaodouya-feedback -->',
    '来自小豆芽 App 的反馈。下面是用户写的原文，放在代码块里，不渲染链接、图片和提及。',
    '',
    `${fence}text`,
    text,
    fence,
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 反馈 ID | \`${input.id}\` |`,
    `| App 版本 | \`${d.appVersion}\` |`,
    `| 系统 | \`${d.os} ${d.osVersion}\` |`,
    `| 语言 | \`${d.locale}\` |`,
    `| 地区 | ${d.region ? `\`${d.region}\`` : '—'} |`,
    `| 附件 | ${describeFeedbackAttachments(input.attachments)} |`,
    '',
    `维护者查看附件：\`cli feedback ${input.id}\`（签名链接 10 分钟有效）。`,
    '',
  ].join('\n');
  return { title, body };
}
