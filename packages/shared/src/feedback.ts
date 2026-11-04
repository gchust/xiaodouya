import { z } from 'zod';
import { formatBytes } from './domain/age';
import { locales } from './i18n/locale';

/**
 * 用户反馈：App 里写的文字会发到 GitHub 的 issue（通常是公开仓库），附件放服务端的平台存储。
 * 新版 App 提交时说明用户看过“照片和视频会公开”的提示（publicAttachments），正文才嵌入附件的公开链接
 * （仓库所有者 2026-11-04 的决定，F-126）；之前的反馈当时承诺过不公开，一律不嵌入。
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
  /**
   * 用户看到的提示是“照片和视频会和文字一起公开”。旧版 App 不发这个字段，它当时写的是“不公开”，
   * 所以没有这个字段、或者不是 true，附件一律不公开。草稿每次保存都以最后一次为准。
   */
  publicAttachments: z.boolean().optional(),
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
  /**
   * 附件会以公开链接放进 issue（服务器配了 PUBLIC_API_URL 和平台存储）。旧服务器没有这个字段，
   * App 当作不公开，也不发 publicAttachments。
   */
  publicAttachments?: boolean;
}

/** 附件的公开链接：`<PUBLIC_API_URL>/v1/public/feedback-files/<令牌>`，302 到短时效的签名链接。 */
export const FEEDBACK_PUBLIC_FILE_PATH = '/v1/public/feedback-files';
/** 32 字节随机数的 base64url（256 位）。和反馈 id、附件 id、对象路径都没有关系，只能查库对上。 */
export const FEEDBACK_PUBLIC_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * 能放进公开链接的类型，返回规范的写法；其他的不公开（只在 issue 里写个数）。
 * 类型是手机报的，服务端不看文件内容：SVG 能带脚本，HEIC 浏览器打不开，都不给公开链接。
 * 新版 App 把照片都重新编码成 JPEG，正常走不到这些分支。
 */
const PUBLIC_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/3gpp',
]);
export function publicFeedbackMime(mime: string): string | null {
  const lower = mime.toLowerCase().split(';')[0]!.trim();
  const normalized = lower === 'image/jpg' ? 'image/jpeg' : lower;
  return PUBLIC_MIMES.has(normalized) ? normalized : null;
}

// ─── 维护者查看收到的反馈 ────────────────────────────────
// 只有服务端 FEEDBACK_VIEWER_EMAILS 里的账号能用，判断只在服务端。App 只拿到 MeResponse.canViewFeedback
// 决定显不显示入口，名单本身不下发。返回的内容里没有提交者的邮箱、账号和家庭。

export const FEEDBACK_INBOX_PAGE = 20;
export const FEEDBACK_INBOX_MAX_PAGE = 50;

/** 游标是上一页最后一条的“创建时间（微秒）_id”，按时间倒序翻页，不会因为同一毫秒的两条漏掉或重复。 */
export const FeedbackInboxQuery = z.object({
  before: z
    .string()
    .regex(/^\d{1,20}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(FEEDBACK_INBOX_MAX_PAGE).optional(),
});
export type FeedbackInboxQuery = z.infer<typeof FeedbackInboxQuery>;

export type FeedbackAttachmentKind = 'image' | 'video';

export interface FeedbackInboxAttachment {
  id: string;
  mime: string;
  size: number;
  kind: FeedbackAttachmentKind;
}

export interface FeedbackInboxItem {
  id: string;
  /** 草稿还没提交，不在这里。 */
  status: Exclude<FeedbackStatus, 'draft'>;
  createdAt: number;
  submittedAt: number | null;
  sentAt: number | null;
  text: string;
  diagnostics: FeedbackDiagnostics;
  issueNumber: number | null;
  issueUrl: string | null;
  /** 提交时有几个附件。比 attachments 多，说明过了保留期已经删掉了。 */
  attachmentCount: number;
  /** 附件以公开链接放进了 issue。改版前的反馈（当时承诺不公开）是 false。 */
  publicAttachments: boolean;
  /** 还在存储里的附件。 */
  attachments: FeedbackInboxAttachment[];
  /** 附件预计什么时候删除。null：一直保留，或者还没建 issue（建好之后才开始算）。 */
  attachmentsDeleteAt: number | null;
  /** 还在排队时最近一次建 issue 失败的原因（只有状态码），给维护者看令牌是不是过期了。 */
  lastError: string | null;
}

export interface FeedbackInboxResponse {
  items: FeedbackInboxItem[];
  /** 下一页的游标，没有更多时为 null。 */
  next: string | null;
}

/** 附件的签名链接，每次打开时现取，和证件一样不超过 10 分钟。 */
export interface FeedbackAttachmentUrlResponse {
  url: string;
  expiresIn: number;
}

export const feedbackAttachmentKind = (mime: string): FeedbackAttachmentKind =>
  mime.toLowerCase().startsWith('video/') ? 'video' : 'image';

/** 比提交时少了几个附件：过了保留期被维护任务删掉了。 */
export const expiredAttachmentCount = (
  item: Pick<FeedbackInboxItem, 'attachmentCount' | 'attachments'>,
) => Math.max(0, item.attachmentCount - item.attachments.length);

const FEEDBACK_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/x-matroska': 'mkv',
};

/**
 * 下载到电脑或手机时的文件名：附件 id 加扩展名。用户原来的文件名可能带人名，服务端本来也不存。
 * 不认识的类型用 MIME 的后半段（只留字母数字），再不行就是 bin。
 */
export function feedbackAttachmentFileName(id: string, mime: string): string {
  const lower = mime.toLowerCase().split(';')[0]!.trim();
  const known = FEEDBACK_EXTENSIONS[lower];
  if (known) return `${id}.${known}`;
  const sub = (lower.split('/')[1] ?? '').replace(/^x-/, '').replace(/[^a-z0-9]/g, '');
  return `${id}.${sub.slice(0, 8) || 'bin'}`;
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

const kindName = (mime: string): '图片' | '视频' =>
  mime.toLowerCase().startsWith('video/') ? '视频' : '图片';

export interface FeedbackIssueAttachment {
  mime: string;
  size: number;
  /** 公开链接。null 或没有：不公开，只写个数。 */
  url?: string | null;
}

/** 附件写个数、类型和大小。文件名可能带名字，不写。公开的在正文下面另有链接。 */
export function describeFeedbackAttachments(
  attachments: readonly FeedbackIssueAttachment[],
): string {
  if (attachments.length === 0) return '没有';
  const parts = attachments.map((a) => `${kindName(a.mime)} ${formatBytes(a.size)}`);
  const head = `${attachments.length} 个（${parts.join('，')}）`;
  const shown = attachments.filter((a) => a.url).length;
  if (shown === 0) return `${head}，只在服务端的私有存储里，不公开`;
  const hidden = attachments.length - shown;
  return `${head}，${shown} 个公开在下面${hidden > 0 ? `，${hidden} 个不公开` : ''}`;
}

/**
 * 公开的附件：图片用 `![]()` 嵌入（GitHub 经它的图片代理加载），视频写成链接（外链视频不会放进播放器）。
 * 链接是服务端拼的：PUBLIC_API_URL 加 base64url 的令牌，没有用户能控制的字符。
 */
function attachmentSection(
  attachments: readonly FeedbackIssueAttachment[],
  days: number | null | undefined,
): string[] {
  const shown = attachments.filter((a): a is FeedbackIssueAttachment & { url: string } =>
    Boolean(a.url),
  );
  if (shown.length === 0) return [];
  const counter = { 图片: 0, 视频: 0 };
  const lines = shown.map((a) => {
    const kind = kindName(a.mime);
    counter[kind] += 1;
    const label = `${kind} ${counter[kind]}（${formatBytes(a.size)}）`;
    return kind === '图片' ? `![${label}](${a.url})` : `[${label}](${a.url})`;
  });
  const expiry = days
    ? `附件在 issue 建好 ${days} 天后删除，之后链接打不开；GitHub 的图片缓存可能还会留一段时间。`
    : '附件一直保留，用户删除账号时删除，之后链接打不开；GitHub 的图片缓存可能还会留一段时间。';
  return ['### 附件', '', ...lines.flatMap((l) => [l, '']), expiry, ''];
}

export interface FeedbackIssueInput {
  id: string;
  text: string;
  diagnostics: FeedbackDiagnostics;
  attachments: readonly FeedbackIssueAttachment[];
  /** 附件保留几天，写在公开链接下面。null：一直保留。 */
  attachmentDays?: number | null;
}

/**
 * issue 的标题和正文。这里能出现的只有：用户写的文字（在代码块里）、反馈 id、诊断信息（正则校验过）、
 * 附件的类型和大小，以及同意公开的附件的公开链接。邮箱、账号、家庭、宝宝的信息、附件 id 和对象路径
 * 都不在输入里，也就写不进去。
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
    ...attachmentSection(input.attachments, input.attachmentDays),
    `维护者查看附件：\`cli feedback ${input.id}\`（签名链接 10 分钟有效），或在 App 的「收到的反馈」里查看。`,
    '',
  ].join('\n');
  return { title, body };
}
