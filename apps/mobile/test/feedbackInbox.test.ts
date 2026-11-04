import { type FeedbackInboxItem, setLocale } from '@xiaodouya/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendInboxPage,
  inboxAttachmentRows,
  inboxStatusText,
  shortFeedbackId,
} from '../src/lib/feedbackInbox';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function item(n: number, attachments: FeedbackInboxItem['attachments'] = []): FeedbackInboxItem {
  return {
    id: uuid(n),
    status: 'sent',
    createdAt: 1_767_225_600_000 - n,
    submittedAt: null,
    sentAt: null,
    text: `第 ${n} 条`,
    diagnostics: { appVersion: '0.4.0', os: 'android', osVersion: '15', locale: 'zh' },
    issueNumber: n,
    issueUrl: null,
    attachmentCount: attachments.length,
    publicAttachments: false,
    attachments,
    attachmentsDeleteAt: null,
    lastError: null,
  };
}

afterEach(() => setLocale('zh'));

describe('收到的反馈', () => {
  it('翻页接在后面，刷新和翻页交错时同一条不重复', () => {
    const first = [item(1), item(2)];
    const merged = appendInboxPage(first, [item(2), item(3), item(3)]);
    expect(merged.map((i) => i.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(appendInboxPage([], [])).toEqual([]);
  });

  it('附件照片和视频各自编号，文件名是附件 id 加扩展名', () => {
    const rows = inboxAttachmentRows(
      item(1, [
        { id: uuid(11), mime: 'image/jpeg', size: 3_200_000, kind: 'image' },
        { id: uuid(12), mime: 'video/mp4', size: 9_000_000, kind: 'video' },
        { id: uuid(13), mime: 'image/png', size: 100, kind: 'image' },
      ]),
    );
    expect(rows.map((r) => r.label)).toEqual(['照片 1', '视频 1', '照片 2']);
    expect(rows.map((r) => r.fileName)).toEqual([
      `${uuid(11)}.jpg`,
      `${uuid(12)}.mp4`,
      `${uuid(13)}.png`,
    ]);
    setLocale('en');
    expect(inboxAttachmentRows(item(1, [rows[1]!.attachment]))[0]?.label).toBe('Video 1');
  });

  it('状态说的是 issue 有没有建好，id 只显示前 8 位', () => {
    expect(inboxStatusText('sent')).toBe('已建 issue');
    expect(inboxStatusText('queued')).toBe('还没建 issue');
    expect(shortFeedbackId(uuid(1))).toBe('00000000');
  });
});
