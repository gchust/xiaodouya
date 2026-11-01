import type { Collection } from '@xiaodouya/shared';
import * as SQLite from 'expo-sqlite';
import type { LocalDb, StoredRecord } from './store';
import type { UploadJob, UploadQueueDb } from './uploadQueue';

interface Row {
  id: string;
  collection: string;
  data: string;
  deleted: number;
  updated_at: number;
  dirty: number;
}

/** 单个 SQLite 文件保存记录和上传队列。App 被杀后两者都能恢复。 */
export class SqliteDb implements LocalDb, UploadQueueDb {
  private constructor(private db: SQLite.SQLiteDatabase) {}

  static async open(name = 'xiaodouya.db'): Promise<SqliteDb> {
    const db = await SQLite.openDatabaseAsync(name);
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY NOT NULL,
        collection TEXT NOT NULL,
        data TEXT NOT NULL,
        deleted INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        dirty INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_dirty ON records(dirty);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY NOT NULL, job TEXT NOT NULL);
    `);
    return new SqliteDb(db);
  }

  async loadAll(): Promise<StoredRecord[]> {
    const rows = await this.db.getAllAsync<Row>('SELECT * FROM records');
    return rows.map((r) => ({
      id: r.id,
      collection: r.collection as Collection,
      data: JSON.parse(r.data) as unknown,
      deleted: r.deleted === 1,
      updatedAt: r.updated_at,
      dirty: r.dirty === 1,
    }));
  }

  private upsert(db: SQLite.SQLiteDatabase, r: StoredRecord) {
    return db.runAsync(
      `INSERT INTO records (id, collection, data, deleted, updated_at, dirty) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET collection = excluded.collection, data = excluded.data,
         deleted = excluded.deleted, updated_at = excluded.updated_at, dirty = excluded.dirty`,
      [
        r.id,
        r.collection,
        JSON.stringify(r.data ?? null),
        r.deleted ? 1 : 0,
        r.updatedAt,
        r.dirty ? 1 : 0,
      ],
    );
  }

  async put(record: StoredRecord): Promise<void> {
    await this.upsert(this.db, record);
  }

  async putMany(records: StoredRecord[], cursor: number): Promise<void> {
    // 同一事务写入记录和游标：中途崩溃时，要么都生效，要么下次重新拉取。
    await this.db.withTransactionAsync(async () => {
      for (const record of records) await this.upsert(this.db, record);
      await this.db.runAsync(
        `INSERT INTO meta (key, value) VALUES ('cursor', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [String(cursor)],
      );
    });
  }

  async getCursor(): Promise<number> {
    const row = await this.db.getFirstAsync<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'cursor'",
    );
    return row ? Number(row.value) : 0;
  }

  async clear(): Promise<void> {
    await this.db.execAsync('DELETE FROM records; DELETE FROM meta; DELETE FROM uploads;');
  }

  async loadJobs(): Promise<UploadJob[]> {
    const rows = await this.db.getAllAsync<{ job: string }>('SELECT job FROM uploads');
    return rows.map((r) => JSON.parse(r.job) as UploadJob);
  }

  async saveJob(job: UploadJob): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO uploads (id, job) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET job = excluded.job`,
      [job.key, JSON.stringify(job)],
    );
  }

  async deleteJob(key: string): Promise<void> {
    await this.db.runAsync('DELETE FROM uploads WHERE id = ?', [key]);
  }
}
