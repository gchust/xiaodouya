import {
  type FeedbackInboxAttachment,
  type FeedbackInboxItem,
  feedbackAttachmentFileName,
  t,
} from '@xiaodouya/shared';

/**
 * 「收到的反馈」页面用的纯逻辑。权限在服务端（FEEDBACK_VIEWER_EMAILS），这里只管怎么显示。
 */

/** 翻到下一页时接在后面。刷新和翻页可能交错，同一条只留第一次出现的。 */
export function appendInboxPage(
  previous: readonly FeedbackInboxItem[],
  page: readonly FeedbackInboxItem[],
): FeedbackInboxItem[] {
  const seen = new Set(previous.map((i) => i.id));
  return [...previous, ...page.filter((i) => !seen.has(i.id) && seen.add(i.id))];
}

export interface InboxAttachmentRow {
  attachment: FeedbackInboxAttachment;
  /** 照片 1、照片 2、视频 1：照片和视频各自编号，和用户选的顺序一致。 */
  label: string;
  /** 下载时的文件名：附件 id 加扩展名，和 `cli feedback --download` 一样。 */
  fileName: string;
}

export function inboxAttachmentRows(
  item: Pick<FeedbackInboxItem, 'attachments'>,
): InboxAttachmentRow[] {
  const counts = { image: 0, video: 0 };
  return item.attachments.map((attachment) => {
    counts[attachment.kind] += 1;
    return {
      attachment,
      label: t().feedback.attachmentLabel(attachment.kind === 'video', counts[attachment.kind]),
      fileName: feedbackAttachmentFileName(attachment.id, attachment.mime),
    };
  });
}

export const inboxStatusText = (status: FeedbackInboxItem['status']) =>
  status === 'sent' ? t().feedback.inboxStatusSent : t().feedback.inboxStatusQueued;

export const shortFeedbackId = (id: string) => id.slice(0, 8);
