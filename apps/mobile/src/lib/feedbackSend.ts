/** 发送反馈的步骤。不依赖 React Native，便于测试；文件和网络由调用方注入。 */
import {
  type CreateFeedbackRequest,
  type CreateFeedbackResponse,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_TEXT,
  type FeedbackConfig,
  type FeedbackDiagnostics,
  type FeedbackStatus,
  type FeedbackUploadTarget,
  feedbackAttachmentLimit,
} from '@xiaodouya/shared';
import { z } from 'zod';

/** 草稿存在手机上，发出去之前 App 被杀、断网都不丢。附件是复制进 App 私有目录的副本。 */
export const FeedbackDraft = z.object({
  id: z.uuid(),
  text: z.string().max(FEEDBACK_MAX_TEXT),
  files: z
    .array(
      z.object({
        id: z.uuid(),
        uri: z.string().min(1),
        mime: z.string().min(1),
        size: z.number().int().positive(),
        kind: z.enum(['image', 'video']),
        /** 这一次的上传已经成功。服务端要到提交时才核对，核对不过会让它从头再传。 */
        uploaded: z.boolean(),
        /**
         * 照片已经重新编码成 JPEG（长边 2048，没有 EXIF、GPS）。旧版本存下的草稿没有这个字段，
         * 里面是原图，发送前要先处理（见 needsPrepare）。视频不处理，用不到它。
         */
        prepared: z.boolean().optional(),
      }),
    )
    .max(FEEDBACK_MAX_ATTACHMENTS),
});
export type FeedbackDraft = z.infer<typeof FeedbackDraft>;
export type FeedbackDraftFile = FeedbackDraft['files'][number];

export interface FeedbackSendDeps {
  create(body: CreateFeedbackRequest): Promise<CreateFeedbackResponse>;
  submit(id: string): Promise<{ status: FeedbackStatus }>;
  /** 返回 HTTP 状态码。 */
  put(file: FeedbackDraftFile, target: FeedbackUploadTarget): Promise<number>;
  /** 每传好一个附件就存一次草稿，被打断后不用重传。 */
  save(draft: FeedbackDraft): Promise<void>;
  /** 把一张没处理过的照片重新编码，返回处理后的文件。失败就抛错。 */
  prepare(file: FeedbackDraftFile): Promise<FeedbackDraftFile>;
  onProgress?(uploaded: number, total: number): void;
}

export class FeedbackUploadFailed extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

/** 有照片压缩不了。不退回上传原图：原图可能带着拍摄地点，而附件会公开。 */
export class FeedbackPrepareFailed extends Error {
  constructor() {
    super('prepare failed');
  }
}

/**
 * 照片一律重新编码再上传：压缩（原图可能几十 MB，单个 PUT 在慢网上传不完），解码后重新编码的 JPEG
 * 也不带原图的 EXIF 和 GPS。不管附件公不公开都这样做。视频没有转码能力，原样上传。
 */
export const needsPrepare = (file: { kind: 'image' | 'video'; prepared?: boolean }) =>
  file.kind === 'image' && !file.prepared;

/**
 * 附件给谁看，决定页面上的提示，也决定提交时说不说“同意公开”。
 * - public：附件和文字一起公开在 issue 里
 * - linked：仓库是私有的，但附件是不用登录就能打开的链接
 * - private：附件不进 issue（旧服务器、服务器没配公开链接），只有开发者能看
 * 离线时问不到服务器，按会公开提醒：说重了只是多提醒一句，反过来就是没告诉用户。
 */
export type AttachmentVisibility = 'public' | 'linked' | 'private';
export function attachmentVisibility(
  server: FeedbackConfig | null | undefined,
): AttachmentVisibility {
  if (server === undefined) return 'public';
  if (!server?.publicAttachments) return 'private';
  return server.public ? 'public' : 'linked';
}

/** 服务端说附件没传到或大小不对：存储里的不算数，全部重传一次。 */
const RESTART_CODES = new Set(['not_uploaded', 'size_mismatch']);

/**
 * 建草稿 → 传还没传过的附件 → 提交。同一份草稿（同一个 id）怎么重试都不会多出一条反馈。
 * 返回 queued 也是成功：服务端已经存下了，GitHub 暂时不可用时它会自己重试。
 */
export async function sendFeedbackDraft(
  draft: FeedbackDraft,
  diagnostics: FeedbackDiagnostics,
  deps: FeedbackSendDeps,
  /** publicAttachments：用户看到的提示是“照片和视频会公开”（attachmentVisibility 不是 private）。 */
  { publicAttachments }: { publicAttachments: boolean },
): Promise<FeedbackStatus> {
  for (const [i, file] of draft.files.entries()) {
    if (!needsPrepare(file)) continue;
    let prepared: FeedbackDraftFile;
    try {
      prepared = await deps.prepare(file);
    } catch {
      throw new FeedbackPrepareFailed();
    }
    // 换了文件，以前传上去的不算数。
    draft.files[i] = { ...prepared, prepared: true, uploaded: false };
    await deps.save(draft);
  }
  for (let round = 0; ; round++) {
    const created = await deps.create({
      id: draft.id,
      text: draft.text,
      diagnostics,
      attachments: draft.files.map(({ id, mime, size }) => ({ id, mime, size })),
      publicAttachments,
    });
    // 上次其实已经提交成功，只是没收到响应。
    if (created.status !== 'draft') return created.status;
    const total = draft.files.length;
    const todo = created.uploads.filter(
      (target) => !draft.files.find((f) => f.id === target.id)?.uploaded,
    );
    let done = total - todo.length;
    deps.onProgress?.(done, total);
    for (const target of todo) {
      const file = draft.files.find((f) => f.id === target.id);
      if (!file) continue;
      const status = await deps.put(file, target);
      if (status < 200 || status >= 300) throw new FeedbackUploadFailed(status);
      file.uploaded = true;
      await deps.save(draft);
      done += 1;
      deps.onProgress?.(done, total);
    }
    try {
      return (await deps.submit(draft.id)).status;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (round > 0 || typeof code !== 'string' || !RESTART_CODES.has(code)) throw error;
      for (const file of draft.files) file.uploaded = false;
      await deps.save(draft);
    }
  }
}

export type AttachmentRejection =
  | { reason: 'tooMany' }
  | { reason: 'unsupported' }
  | { reason: 'tooBig'; maxBytes: number };

/**
 * 选好的文件哪些能加进来。超出个数的丢掉，类型不对、太大的跳过，都告诉用户第一个原因。
 * 照片不在这里看大小：先压缩，压缩后再检查（见 FeedbackScreen）。
 */
export function admitAttachments<T extends { mime: string; size: number }>(
  existing: number,
  picked: readonly T[],
): { accepted: T[]; rejection: AttachmentRejection | null } {
  const accepted: T[] = [];
  let rejection: AttachmentRejection | null = null;
  for (const file of picked) {
    const limit = feedbackAttachmentLimit(file.mime);
    if (limit === null) {
      rejection ??= { reason: 'unsupported' };
      continue;
    }
    if (!file.mime.toLowerCase().startsWith('image/') && file.size > limit) {
      rejection ??= { reason: 'tooBig', maxBytes: limit };
      continue;
    }
    if (existing + accepted.length >= FEEDBACK_MAX_ATTACHMENTS) {
      rejection ??= { reason: 'tooMany' };
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejection };
}
