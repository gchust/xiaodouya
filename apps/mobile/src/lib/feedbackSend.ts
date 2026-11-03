/** 发送反馈的步骤。不依赖 React Native，便于测试；文件和网络由调用方注入。 */
import {
  type CreateFeedbackRequest,
  type CreateFeedbackResponse,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_TEXT,
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
  onProgress?(uploaded: number, total: number): void;
}

export class FeedbackUploadFailed extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
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
): Promise<FeedbackStatus> {
  for (let round = 0; ; round++) {
    const created = await deps.create({
      id: draft.id,
      text: draft.text,
      diagnostics,
      attachments: draft.files.map(({ id, mime, size }) => ({ id, mime, size })),
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

/** 选好的文件哪些能加进来。超出个数的丢掉，类型不对、太大的跳过，都告诉用户第一个原因。 */
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
    if (file.size > limit) {
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
