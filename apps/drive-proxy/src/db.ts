/**
 * 元数据库的最小接口，是 Cloudflare D1 的子集。生产用 D1，测试用 node:sqlite 包一层（test/sqlite-db.ts），
 * 两边跑的是同一份 SQL。
 */
export interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface Db {
  prepare(sql: string): Statement;
  /** 一批语句在一个事务里执行（D1 的 batch 就是这样）。 */
  batch(statements: Statement[]): Promise<unknown>;
}

/**
 * 表结构。D1 用 `wrangler d1 execute --file schema.sql` 建表；和服务端的迁移一样，只追加不修改。
 *
 * - objects / chunks：一个对象由按顺序拼起来的若干块组成，每块是 Drive 里的一个文件。
 *   单个 PUT 是一块；分片上传完成时每片一块，之后由后台合并成一块。
 * - uploads / parts：进行中的分片上传。
 * - orphans：不再被引用、等着删的 Drive 文件。晚一天删：正在下载的请求可能还在读旧的块。
 * - compactions：后台合并的进度（Drive 续传会话的地址）。
 * - folders：Drive 里的分桶文件夹。一个普通文件夹最多直接放 50 万个文件。
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS objects (
  key TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  etag TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  blob_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (key, idx)
);
CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS parts (
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  blob_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  etag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);
CREATE TABLE IF NOT EXISTS orphans (
  blob_id TEXT PRIMARY KEY,
  delete_after INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS compactions (
  key TEXT PRIMARY KEY,
  etag TEXT NOT NULL,
  session TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  name TEXT PRIMARY KEY,
  drive_id TEXT NOT NULL
);
`;
