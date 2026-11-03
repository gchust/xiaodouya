import type {
  CreateFeedbackRequest,
  CreateFeedbackResponse,
  FeedbackStatus,
} from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import {
  admitAttachments,
  FeedbackDraft,
  type FeedbackDraftFile,
  type FeedbackSendDeps,
  FeedbackUploadFailed,
  sendFeedbackDraft,
} from '../src/lib/feedbackSend';

const diagnostics = { appVersion: '0.3.3', os: 'android', osVersion: '15', locale: 'zh' } as const;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function draft(files = 2): FeedbackDraft {
  return {
    id: uuid(99),
    text: '闪退了',
    files: Array.from({ length: files }, (_, i) => ({
      id: uuid(i + 1),
      uri: `file:///feedback/${i}`,
      mime: 'image/jpeg',
      size: 100,
      kind: 'image' as const,
      uploaded: false,
    })),
  };
}

/** 假的服务端：记下调用顺序。 */
function fakeServer(
  options: { submitErrors?: string[]; putStatus?: number; status?: FeedbackStatus } = {},
) {
  const calls: string[] = [];
  const saved: FeedbackDraft[] = [];
  const submitErrors = [...(options.submitErrors ?? [])];
  const deps: FeedbackSendDeps = {
    async create(body: CreateFeedbackRequest): Promise<CreateFeedbackResponse> {
      calls.push(`create:${body.attachments.length}`);
      return {
        id: body.id,
        status: options.status ?? 'draft',
        uploads: body.attachments.map((a) => ({
          id: a.id,
          url: `https://s3.example/${a.id}`,
          headers: {},
          expiresIn: 3600,
        })),
      };
    },
    async submit() {
      calls.push('submit');
      const code = submitErrors.shift();
      if (code) throw Object.assign(new Error(code), { code });
      return { status: 'sent' as const };
    },
    async put(file: FeedbackDraftFile) {
      calls.push(`put:${file.id.slice(-1)}`);
      return options.putStatus ?? 200;
    },
    async save(d: FeedbackDraft) {
      saved.push(structuredClone(d));
    },
  };
  return { deps, calls, saved };
}

describe('发送反馈', () => {
  it('建草稿、传附件、提交，每传好一个存一次草稿', async () => {
    const { deps, calls, saved } = fakeServer();
    const d = draft();
    expect(await sendFeedbackDraft(d, diagnostics, deps)).toBe('sent');
    expect(calls).toEqual(['create:2', 'put:1', 'put:2', 'submit']);
    expect(saved.map((s) => s.files.map((f) => f.uploaded))).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it('上次传过的附件不再传', async () => {
    const { deps, calls } = fakeServer();
    const d = draft();
    d.files[0]!.uploaded = true;
    await sendFeedbackDraft(d, diagnostics, deps);
    expect(calls).toEqual(['create:2', 'put:2', 'submit']);
  });

  it('上次其实已经提交了：不再上传，直接返回状态', async () => {
    const { deps, calls } = fakeServer({ status: 'queued' });
    expect(await sendFeedbackDraft(draft(), diagnostics, deps)).toBe('queued');
    expect(calls).toEqual(['create:2']);
  });

  it('服务端说附件没传到：全部重传一次，再不行就报错', async () => {
    const once = fakeServer({ submitErrors: ['not_uploaded'] });
    const d = draft();
    expect(await sendFeedbackDraft(d, diagnostics, once.deps)).toBe('sent');
    expect(once.calls).toEqual([
      'create:2',
      'put:1',
      'put:2',
      'submit',
      'create:2',
      'put:1',
      'put:2',
      'submit',
    ]);
    const twice = fakeServer({ submitErrors: ['size_mismatch', 'size_mismatch'] });
    await expect(sendFeedbackDraft(draft(), diagnostics, twice.deps)).rejects.toThrow(
      'size_mismatch',
    );
  });

  it('上传失败和别的错误原样抛出，草稿里已传的标记还在', async () => {
    const failing = fakeServer({ putStatus: 403 });
    await expect(sendFeedbackDraft(draft(), diagnostics, failing.deps)).rejects.toBeInstanceOf(
      FeedbackUploadFailed,
    );
    const network = fakeServer({ submitErrors: ['network'] });
    const d = draft();
    await expect(sendFeedbackDraft(d, diagnostics, network.deps)).rejects.toThrow('network');
    expect(d.files.every((f) => f.uploaded)).toBe(true);
  });
});

describe('加附件', () => {
  const file = (mime: string, size = 10) => ({ mime, size });

  it('只收照片和视频，太大的跳过，超过 5 个的丢掉', () => {
    expect(admitAttachments(0, [file('application/pdf')])).toEqual({
      accepted: [],
      rejection: { reason: 'unsupported' },
    });
    const big = admitAttachments(0, [file('image/png', 21 * 1024 * 1024), file('image/png')]);
    expect(big.accepted).toHaveLength(1);
    expect(big.rejection).toEqual({ reason: 'tooBig', maxBytes: 20 * 1024 * 1024 });
    const many = admitAttachments(3, [file('image/png'), file('video/mp4'), file('image/png')]);
    expect(many.accepted).toHaveLength(2);
    expect(many.rejection).toEqual({ reason: 'tooMany' });
  });

  it('存下来的草稿要过校验：坏掉的内容不当真', () => {
    expect(FeedbackDraft.safeParse(draft()).success).toBe(true);
    expect(FeedbackDraft.safeParse({ ...draft(), id: 'x' }).success).toBe(false);
    expect(FeedbackDraft.safeParse({ ...draft(6) }).success).toBe(false);
  });
});
