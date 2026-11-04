/**
 * 反馈的草稿和附件副本，放在 App 私有目录的 feedback/ 里。
 * 选择器给的文件在缓存目录，随时可能被系统清掉，所以加附件时就复制过来；发出去之后整个目录删掉。
 * 退出登录、换账号时随本地数据一起清除（app.tsx 的 wipeLocalData）：里面可能拍到孩子。
 */
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths, UploadType } from 'expo-file-system';
import { FeedbackDraft, type FeedbackDraftFile, needsPrepare } from './feedbackSend';
import { compressFeedbackPhoto, type PickedFile } from './media';

function feedbackDir(): Directory {
  const dir = new Directory(Paths.document, 'feedback');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

const draftFile = () => new File(feedbackDir(), 'draft.json');

export function newFeedbackDraft(): FeedbackDraft {
  return { id: Crypto.randomUUID(), text: '', files: [] };
}

/** 读不出来、校验不过时当作没有草稿；附件副本没了的去掉。 */
export async function loadFeedbackDraft(): Promise<FeedbackDraft | null> {
  try {
    const file = draftFile();
    if (!file.exists) return null;
    const parsed = FeedbackDraft.safeParse(JSON.parse(await file.text()));
    if (!parsed.success) return null;
    return { ...parsed.data, files: parsed.data.files.filter((f) => new File(f.uri).exists) };
  } catch {
    return null;
  }
}

export async function saveFeedbackDraft(draft: FeedbackDraft): Promise<void> {
  const file = draftFile();
  if (!file.exists) file.create();
  await file.write(JSON.stringify(draft));
}

/**
 * 照片在这里就压缩成 JPEG、去掉元数据（见 compressFeedbackPhoto），失败就抛错，这张不加进来。
 * 视频复制，不挪：E2E 的样例和系统选择器的副本可能还有别处在用。
 */
export async function adoptFeedbackFile(picked: PickedFile): Promise<FeedbackDraftFile> {
  const id = Crypto.randomUUID();
  const kind = picked.kind === 'video' ? 'video' : 'image';
  if (kind === 'image') {
    return prepareFeedbackFile({
      id,
      uri: picked.uri,
      mime: picked.mime,
      size: picked.size,
      kind,
      uploaded: false,
    });
  }
  const target = new File(feedbackDir(), id);
  if (target.exists) target.delete();
  await new File(picked.uri).copy(target);
  return {
    id,
    uri: target.uri,
    mime: picked.mime,
    size: target.size ?? picked.size,
    kind,
    uploaded: false,
  };
}

/**
 * 把照片重新编码进 feedback/ 目录，返回处理后的文件（同一个附件 id）。旧版本存下的草稿发送前也走这里。
 * 来源在 feedback/ 里（旧草稿的原图副本）的话，处理完删掉它：原图带着拍摄地点，不留在草稿里。
 */
export async function prepareFeedbackFile(file: FeedbackDraftFile): Promise<FeedbackDraftFile> {
  if (!needsPrepare(file)) return file;
  const target = new File(feedbackDir(), `${file.id}.jpg`);
  const { size } = await compressFeedbackPhoto(file.uri, target.uri);
  if (file.uri !== target.uri && file.uri.startsWith(feedbackDir().uri)) {
    removeFeedbackFile(file);
  }
  return { ...file, uri: target.uri, mime: 'image/jpeg', size, prepared: true, uploaded: false };
}

export function removeFeedbackFile(file: FeedbackDraftFile): void {
  try {
    const local = new File(file.uri);
    if (local.exists) local.delete();
  } catch {
    // 删不掉的副本会在发送成功或退出登录时随目录一起删。
  }
}

export function clearFeedbackDraft(): void {
  try {
    const dir = new Directory(Paths.document, 'feedback');
    if (dir.exists) dir.delete();
  } catch {
    // 清不掉也不影响退出登录。
  }
}

export async function putFeedbackFile(
  file: FeedbackDraftFile,
  target: { url: string; headers: Record<string, string> },
): Promise<number> {
  const local = new File(file.uri);
  // 410：副本没了，只能让用户重新选。
  if (!local.exists) return 410;
  const result = await local.upload(target.url, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: target.headers,
  });
  return result.status;
}
