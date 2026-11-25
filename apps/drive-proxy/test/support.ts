import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { type BlobLabel, BlobNotFound, type BlobStore, SESSION_ALIGN } from '../src/blobs';
import { type Db, SCHEMA, type Statement } from '../src/db';
import { countedStream } from '../src/fixed';

/** D1 接口的 node:sqlite 实现，只给测试和本机跑用。 */
export function sqliteDb(path = ':memory:'): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA);
  const statement = (
    sql: string,
    values: SQLInputValue[] = [],
  ): Statement & {
    exec(): unknown;
  } => ({
    bind: (...v) => statement(sql, v),
    first: async <T>() => (raw.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ results: raw.prepare(sql).all(...values) as T[] }),
    run: async () => raw.prepare(sql).run(...values),
    exec: () => raw.prepare(sql).run(...values),
  });
  return {
    raw,
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      raw.exec('BEGIN');
      try {
        for (const s of statements) (s as ReturnType<typeof statement>).exec();
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** 本机目录当块存储，行为照 Drive：续传段必须按 256 KiB 对齐。 */
export function fsBlobs(
  dir: string,
): BlobStore & { count(): number; calls: string[]; labels: Map<string, BlobLabel> } {
  mkdirSync(dir, { recursive: true });
  const calls: string[] = [];
  const path = (id: string) => join(dir, id);
  const sessions = new Map<string, { id: string; received: number; done: boolean }>();
  const labels = new Map<string, BlobLabel>();
  return {
    calls,
    labels,
    count: () => {
      return readdirSync(dir).length;
    },
    async put(body, size, label) {
      calls.push('put');
      const bytes = await readAll(body);
      if (bytes.length !== size) throw new Error('size mismatch');
      const id = randomUUID();
      labels.set(id, label);
      writeFileSync(path(id), bytes);
      return id;
    },
    async get(id, start, end) {
      calls.push('get');
      let data: Buffer;
      try {
        data = readFileSync(path(id));
      } catch {
        throw new BlobNotFound(id);
      }
      return new Response(new Uint8Array(data.subarray(start, end + 1))).body!;
    },
    async delete(id) {
      calls.push('delete');
      rmSync(path(id), { force: true });
    },
    async startSession(_total, label) {
      calls.push('startSession');
      const session = randomUUID();
      const id = randomUUID();
      writeFileSync(path(id), new Uint8Array());
      labels.set(id, label);
      sessions.set(session, { id, received: 0, done: false });
      return session;
    },
    async sessionOffset(session) {
      const s = sessions.get(session);
      if (!s) return null;
      return s.done ? { blobId: s.id } : s.received;
    },
    async append(session, body, offset, size, total) {
      calls.push('append');
      const s = sessions.get(session);
      if (!s || s.done) throw new Error('session gone');
      if (offset !== s.received) throw new Error(`offset ${offset} != ${s.received}`);
      const last = offset + size === total;
      if (!last && size % SESSION_ALIGN !== 0) throw new Error('unaligned');
      const bytes = await readAll(body);
      if (bytes.length !== size) throw new Error('size mismatch');
      const fd = openSync(path(s.id), 'r+');
      writeSync(fd, bytes, 0, bytes.length, offset);
      closeSync(fd);
      s.received += size;
      if (!last) return null;
      s.done = true;
      if (statSync(path(s.id)).size !== total) throw new Error('total mismatch');
      return s.id;
    },
  };
}

/** Node 的 fetch 看到 content-length 头就够了，不需要 Workers 的 FixedLengthStream。 */
export const fixedLength = countedStream;
