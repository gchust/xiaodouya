import type {
  CreateFeedbackRequest,
  CreateFeedbackResponse,
  FeedbackStatus,
} from '@xiaodouya/shared';
import { describe, expect, it } from 'vitest';
import {
  admitAttachments,
  attachmentVisibility,
  FeedbackDraft,
  type FeedbackDraftFile,
  FeedbackPrepareFailed,
  type FeedbackSendDeps,
  FeedbackUploadFailed,
  needsPrepare,
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
      prepared: true,
    })),
  };
}

/** 假的服务端：记下调用顺序。 */
function fakeServer(
  options: {
    submitErrors?: string[];
    putStatus?: number;
    status?: FeedbackStatus;
    prepareFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const bodies: CreateFeedbackRequest[] = [];
  const saved: FeedbackDraft[] = [];
  const submitErrors = [...(options.submitErrors ?? [])];
  const deps: FeedbackSendDeps = {
    async create(body: CreateFeedbackRequest): Promise<CreateFeedbackResponse> {
      calls.push(`create:${body.attachments.length}`);
      bodies.push(structuredClone(body));
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
    async prepare(file: FeedbackDraftFile) {
      calls.push(`prepare:${file.id.slice(-1)}`);
      if (options.prepareFails) throw new Error('decode failed');
      return { ...file, uri: `${file.uri}.jpg`, mime: 'image/jpeg', size: 50, prepared: true };
    },
  };
  return { deps, calls, saved, bodies };
}

const SHOWN_PUBLIC = { publicAttachments: true };

describe('发送反馈', () => {
  it('建草稿、传附件、提交，每传好一个存一次草稿', async () => {
    const { deps, calls, saved } = fakeServer();
    const d = draft();
    expect(await sendFeedbackDraft(d, diagnostics, deps, SHOWN_PUBLIC)).toBe('sent');
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
    await sendFeedbackDraft(d, diagnostics, deps, SHOWN_PUBLIC);
    expect(calls).toEqual(['create:2', 'put:2', 'submit']);
  });

  it('上次其实已经提交了：不再上传，直接返回状态', async () => {
    const { deps, calls } = fakeServer({ status: 'queued' });
    expect(await sendFeedbackDraft(draft(), diagnostics, deps, SHOWN_PUBLIC)).toBe('queued');
    expect(calls).toEqual(['create:2']);
  });

  it('服务端说附件没传到：全部重传一次，再不行就报错', async () => {
    const once = fakeServer({ submitErrors: ['not_uploaded'] });
    const d = draft();
    expect(await sendFeedbackDraft(d, diagnostics, once.deps, SHOWN_PUBLIC)).toBe('sent');
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
    await expect(sendFeedbackDraft(draft(), diagnostics, twice.deps, SHOWN_PUBLIC)).rejects.toThrow(
      'size_mismatch',
    );
  });

  it('上传失败和别的错误原样抛出，草稿里已传的标记还在', async () => {
    const failing = fakeServer({ putStatus: 403 });
    await expect(
      sendFeedbackDraft(draft(), diagnostics, failing.deps, SHOWN_PUBLIC),
    ).rejects.toBeInstanceOf(FeedbackUploadFailed);
    const network = fakeServer({ submitErrors: ['network'] });
    const d = draft();
    await expect(sendFeedbackDraft(d, diagnostics, network.deps, SHOWN_PUBLIC)).rejects.toThrow(
      'network',
    );
    expect(d.files.every((f) => f.uploaded)).toBe(true);
  });
});

describe('同意公开附件', () => {
  it('提交时带上用户看到的提示：说了会公开才是 true', async () => {
    const shown = fakeServer();
    await sendFeedbackDraft(draft(), diagnostics, shown.deps, { publicAttachments: true });
    expect(shown.bodies[0]?.publicAttachments).toBe(true);
    const hidden = fakeServer();
    await sendFeedbackDraft(draft(), diagnostics, hidden.deps, { publicAttachments: false });
    expect(hidden.bodies[0]?.publicAttachments).toBe(false);
  });

  it('按服务器的配置决定提示：公开仓库、私有仓库、旧服务器、离线', () => {
    const base = { enabled: true, public: true, attachments: true, attachmentDays: 90 };
    expect(attachmentVisibility({ ...base, publicAttachments: true })).toBe('public');
    expect(attachmentVisibility({ ...base, public: false, publicAttachments: true })).toBe(
      'linked',
    );
    // 旧服务器没有这个字段：附件不公开，也就不说同意。
    expect(attachmentVisibility(base)).toBe('private');
    expect(attachmentVisibility({ ...base, publicAttachments: false })).toBe('private');
    // 离线时问不到：按会公开提醒，宁可多提醒一句。
    expect(attachmentVisibility(undefined)).toBe('public');
  });
});

describe('照片先压缩、去掉元数据再上传', () => {
  it('只有照片要处理，视频原样上传；处理过的不再处理', () => {
    const photo = { kind: 'image' as const, prepared: undefined };
    expect(needsPrepare(photo)).toBe(true);
    expect(needsPrepare({ kind: 'image' as const, prepared: true })).toBe(false);
    expect(needsPrepare({ kind: 'video' as const })).toBe(false);
  });

  it('旧版本存下的草稿里没处理过的照片，发送前先处理，再从头上传', async () => {
    const { deps, calls, saved, bodies } = fakeServer();
    const d = draft(2);
    d.files[0]!.prepared = undefined;
    d.files[0]!.uploaded = true;
    d.files[0]!.mime = 'image/heic';
    expect(await sendFeedbackDraft(d, diagnostics, deps, SHOWN_PUBLIC)).toBe('sent');
    expect(calls).toEqual(['prepare:1', 'create:2', 'put:1', 'put:2', 'submit']);
    expect(bodies[0]?.attachments[0]).toEqual({ id: uuid(1), mime: 'image/jpeg', size: 50 });
    // 处理完先存一次草稿，被杀之后不用再处理。
    expect(saved[0]?.files[0]).toMatchObject({ prepared: true, uploaded: false, size: 50 });
  });

  it('处理失败就不发，绝不退回上传原图', async () => {
    const { deps, calls } = fakeServer({ prepareFails: true });
    const d = draft(1);
    d.files[0]!.prepared = undefined;
    await expect(sendFeedbackDraft(d, diagnostics, deps, SHOWN_PUBLIC)).rejects.toBeInstanceOf(
      FeedbackPrepareFailed,
    );
    expect(calls).toEqual(['prepare:1']);
  });
});

describe('加附件', () => {
  const file = (mime: string, size = 10) => ({ mime, size });

  it('只收照片和视频，太大的视频跳过，超过 5 个的丢掉', () => {
    expect(admitAttachments(0, [file('application/pdf')])).toEqual({
      accepted: [],
      rejection: { reason: 'unsupported' },
    });
    const big = admitAttachments(0, [file('video/mp4', 101 * 1024 * 1024), file('image/png')]);
    expect(big.accepted).toHaveLength(1);
    expect(big.rejection).toEqual({ reason: 'tooBig', maxBytes: 100 * 1024 * 1024 });
    // 大照片先收下：压缩之后再按上限检查。
    expect(admitAttachments(0, [file('image/jpeg', 30 * 1024 * 1024)]).accepted).toHaveLength(1);
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
