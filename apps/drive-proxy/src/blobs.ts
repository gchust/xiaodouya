/** 块存储：生产是 Google Drive（drive.ts），测试是本机目录（test/support.ts）。 */
export interface BlobStore {
  /** 写一个新块，返回它的 id。`body` 必须正好 `size` 字节，否则失败。 */
  put(body: ReadableStream<Uint8Array>, size: number, label: BlobLabel): Promise<string>;
  /** 读一段，`end` 包含在内。块不存在时抛 BlobNotFound。 */
  get(id: string, start: number, end: number): Promise<ReadableStream<Uint8Array>>;
  /** 移走一个块（Drive 是放进回收站，30 天内还能救回来）。已经不在了也算成功。 */
  delete(id: string): Promise<void>;
  /** 合并用的续传会话：一次建好，之后按顺序追加，可以跨多次运行。 */
  startSession(total: number, label: BlobLabel): Promise<string>;
  /**
   * 会话里已经确认收到多少字节。会话失效（过期、被清掉）时返回 null；
   * 已经传完（上次收到了最后一段但没来得及记下）时返回新块的 id。
   */
  sessionOffset(session: string, total: number): Promise<number | null | { blobId: string }>;
  /**
   * 从 `offset` 起追加 `size` 字节。传完最后一段时返回新块的 id，否则返回 null。
   * 除最后一段外，`size` 必须是 SESSION_ALIGN 的整数倍（Drive 续传的要求）。
   */
  append(
    session: string,
    body: ReadableStream<Uint8Array>,
    offset: number,
    size: number,
    total: number,
  ): Promise<string | null>;
}

/**
 * 块属于哪个对象，写在块自己身上（Drive 的 appProperties）。元数据库（D1）丢了或坏了，
 * 还能从 Drive 把“object key → 块”对回来，文件不会变成一堆认不出的随机名字。
 */
export interface BlobLabel {
  key: string;
  /** 分片上传的片号；整个对象（单个 PUT 或合并后的）是 null。 */
  part: number | null;
  /** 这一块属于哪次上传（分片的 uploadId 或对象的 ETag），同一个 key 的新旧块靠它区分。 */
  version: string;
}

/** Drive 续传每段（除最后一段）必须是 256 KiB 的整数倍。 */
export const SESSION_ALIGN = 256 * 1024;

export class BlobNotFound extends Error {
  constructor(id: string) {
    super(`blob not found: ${id}`);
    this.name = 'BlobNotFound';
  }
}
