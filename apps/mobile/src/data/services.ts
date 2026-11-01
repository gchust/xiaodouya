import * as SecureStore from 'expo-secure-store';
import { Api } from '../lib/api';
import { ME_KEY, TOKEN_KEY } from '../lib/storedSession';
import { SqliteDb } from './sqlite';
import { RecordStore } from './store';
import { SyncEngine, type SyncEvents } from './syncEngine';

export interface CoreServices {
  db: SqliteDb;
  api: Api;
  store: RecordStore;
  engine: SyncEngine;
  /** 引擎只读这个对象，界面挂载后把自己的回调放进来。 */
  syncEvents: SyncEvents;
}

let core: Promise<CoreServices> | null = null;

async function open(): Promise<CoreServices> {
  const db = await SqliteDb.open();
  const api = new Api();
  // 界面还没挂载时（小工具的后台同步）也要处理登录失效。界面挂载后会换成自己的处理。
  // 和界面一样只清登录，不动本地数据，里面可能有没同步的记录。
  api.onUnauthorized = () => {
    void SecureStore.deleteItemAsync(TOKEN_KEY);
    void SecureStore.deleteItemAsync(ME_KEY);
  };
  const store = new RecordStore(db);
  await store.load();
  const syncEvents: SyncEvents = {};
  const engine = new SyncEngine(
    store,
    db,
    { sync: (r) => api.sync(r), wait: (c, s) => api.syncWait(c, s) },
    syncEvents,
  );
  return { db, api, store, engine, syncEvents };
}

/**
 * 整个 JS 运行环境只有一份。小工具的后台任务和界面跑在同一个进程的同一个运行环境里：
 * 共用一份才能保证只有一个写入者，内存里的记录、发件箱和数据库不会各说各话。
 */
export function getCoreServices(): Promise<CoreServices> {
  core ??= open().catch((error) => {
    core = null;
    throw error;
  });
  return core;
}
