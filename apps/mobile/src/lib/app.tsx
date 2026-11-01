import NetInfo from '@react-native-community/netinfo';
import {
  type Collection,
  type CollectionData,
  defaultPrefs,
  describeEvent,
  type EventData,
  effectiveUnits,
  type MeResponse,
  type Prefs,
  type RegionDefinition,
  type Role,
  regionFor,
  type ServerRecord,
  type Units,
} from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState } from 'react-native';
import { SqliteDb } from '../data/sqlite';
import { RecordStore, type Snapshot } from '../data/store';
import { SyncEngine, type SyncStatus } from '../data/syncEngine';
import { UploadQueue } from '../data/uploadQueue';
import { useFeedback } from '../ui/overlays';
import { Api, ApiFailure } from './api';
import { DEFAULT_API_URL } from './config';
import { deviceTimezone } from './device';
import { clearDownloads } from './downloads';
import { clearLocalMedia, createUploadTransport } from './media';
import { registerPushToken, scheduleFeedReminder, unregisterPushToken } from './notifications';
import { sessionOwner, shouldClearLocalData, timezoneToSync } from './sessionLogic';

const TOKEN_KEY = 'session.token';
const SERVER_KEY = 'session.server';
const ME_KEY = 'session.me';
const OWNER_KEY = 'session.owner';
const SYNCED_KEY = 'synced';

export type SessionState = 'signedOut' | 'noFamily' | 'syncing' | 'noBaby' | 'ready';

export interface AppApi {
  api: Api;
  store: RecordStore;
  uploads: UploadQueue;
  db: SqliteDb;
  me: MeResponse | null;
  role: Role | null;
  label: string;
  prefs: Prefs;
  serverUrl: string;
  sessionState: SessionState;
  syncStatus: SyncStatus;
  signIn(token: string, serverUrl: string): Promise<void>;
  signOut(): Promise<void>;
  setMe(me: MeResponse): Promise<void>;
  refreshMe(): Promise<void>;
  updatePrefs(patch: Partial<Prefs>): Promise<void>;
  syncNow(): Promise<void>;
  /** 新建或修改记录。id 省略时生成新记录。 */
  write<C extends Collection>(collection: C, data: CollectionData[C], id?: string): Promise<string>;
  remove(id: string): Promise<void>;
}

const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp 必须在 AppProvider 内使用');
  return app;
}

export function useRecords(): Snapshot {
  const { store } = useApp();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function useUploadProgress() {
  const { uploads } = useApp();
  return useSyncExternalStore(uploads.subscribe, uploads.getProgress);
}

/** 家庭的地区，规则见 regionFor。 */
export function useRegion(): RegionDefinition {
  return regionFor(useRecords().baby?.data.region);
}

/** 这个人用的单位。所有显示和输入数量的地方都从这里取。 */
export function useUnits(): Units {
  const { prefs } = useApp();
  return effectiveUnits(prefs.units, useRecords().baby?.data.region);
}

/** 让计时类显示定期刷新。 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(Date.now());
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [intervalMs]);
  return now;
}

interface Services {
  db: SqliteDb;
  store: RecordStore;
  uploads: UploadQueue;
  api: Api;
  engine: SyncEngine;
}

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [services, setServices] = useState<Services | null>(null);
  const [me, setMeState] = useState<MeResponse | null>(null);
  const [serverUrl, setServerUrl] = useState(DEFAULT_API_URL);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [booted, setBooted] = useState(false);
  const [hasSynced, setHasSynced] = useState(false);
  const feedback = useFeedback();
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const db = await SqliteDb.open();
      const api = new Api();
      const store = new RecordStore(db);
      await store.load();
      const uploads = new UploadQueue(db, createUploadTransport(api));
      const engine = new SyncEngine(
        store,
        db,
        { sync: (r) => api.sync(r), wait: (c, s) => api.syncWait(c, s) },
        {
          onStatus: setSyncStatus,
          onRemote: (records) =>
            announceRemote(
              records,
              meRef.current,
              effectiveUnits(meRef.current?.prefs.units, store.getSnapshot().baby?.data.region),
              feedbackRef.current.banner,
            ),
          onRejected: (count) =>
            feedbackRef.current.toast(`有 ${count} 条内容服务器没有接受，只保存在这台手机上`),
          onSynced: () => {
            setHasSynced(true);
            void db.setMeta(SYNCED_KEY, '1');
          },
        },
      );
      const [token, savedServer, savedMe] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(SERVER_KEY),
        SecureStore.getItemAsync(ME_KEY),
      ]);
      api.baseUrl = savedServer ?? DEFAULT_API_URL;
      api.token = token;
      if (savedServer) setServerUrl(savedServer);
      const synced = await db.getMeta(SYNCED_KEY);
      if (cancelled) return;
      clearDownloads();
      setHasSynced(synced === '1');
      setServices({ db, store, uploads, api, engine });
      if (token && savedMe) {
        // 先用缓存的身份立刻进入 App：没网时也不能挡住半夜的记录。
        setMeState(JSON.parse(savedMe) as MeResponse);
      }
      setBooted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistMe = useCallback(async (next: MeResponse) => {
    setMeState(next);
    await SecureStore.setItemAsync(ME_KEY, JSON.stringify(next));
    await SecureStore.setItemAsync(OWNER_KEY, sessionOwner(next.user.id, next.family?.id ?? null));
  }, []);

  const stopServices = useCallback(() => {
    if (!services) return;
    services.engine.stop();
    services.uploads.stop();
    services.api.token = null;
  }, [services]);

  const wipeLocalData = useCallback(async () => {
    if (!services) return;
    await services.store.clear();
    clearDownloads();
    await clearLocalMedia();
    setHasSynced(false);
  }, [services]);

  // 主动退出：清除一切。
  const clearSession = useCallback(async () => {
    stopServices();
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(ME_KEY);
    await SecureStore.deleteItemAsync(OWNER_KEY);
    await wipeLocalData();
    setMeState(null);
  }, [stopServices, wipeLocalData]);

  // 登录失效（过期、被移出家庭、改了密码）：回到登录页，但本地数据一条都不动。
  // 里面可能有没同步的记录，同一个人重新登录后要接着传。
  useEffect(() => {
    if (!services) return;
    services.api.onUnauthorized = () => {
      stopServices();
      void SecureStore.deleteItemAsync(TOKEN_KEY);
      void SecureStore.deleteItemAsync(ME_KEY);
      setMeState(null);
    };
  }, [services, stopServices]);

  const hasFamily = Boolean(me?.family);

  // 启动同步、上传和网络监听。
  useEffect(() => {
    if (!services || !hasFamily) return;
    const { engine, uploads } = services;
    void uploads.load();
    void engine.start();
    const netSub = NetInfo.addEventListener((state) => {
      const online = state.isConnected !== false;
      engine.setOnline(online);
      uploads.setNetwork(!online ? 'none' : state.type === 'wifi' ? 'wifi' : 'cellular');
    });
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void engine.syncNow();
    });
    return () => {
      engine.stop();
      netSub();
      appSub.remove();
    };
  }, [services, hasFamily]);

  // 启动时刷新身份和成员，失败（离线）就继续用缓存。
  const refreshMe = useCallback(async () => {
    if (!services?.api.token) return;
    try {
      await persistMe(await services.api.me());
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.status !== 0) {
        console.warn('刷新账号信息失败');
      }
    }
  }, [services, persistMe]);

  useEffect(() => {
    if (booted) void refreshMe();
  }, [booted, refreshMe]);

  useEffect(() => {
    if (services && hasFamily && me?.role !== 'viewer') {
      void registerPushToken(services.api);
    }
  }, [services, hasFamily, me?.role]);

  const prefs = me?.prefs ?? defaultPrefs;

  // 夜间安静在服务端按这个时区判断。失败了也没关系，下次刷新发现不一样会再写一次。
  useEffect(() => {
    if (!services || !me) return;
    const timezone = timezoneToSync(me.prefs.timezone, deviceTimezone());
    if (!timezone) return;
    const next = { ...me.prefs, timezone };
    void persistMe({ ...me, prefs: next });
    void services.api.updatePrefs(next).catch(() => {});
  }, [services, me, persistMe]);

  // 记录或设置变化后，重新安排本机的喂奶提醒。
  useEffect(() => {
    if (!services || me?.role === 'viewer' || !hasFamily) return;
    const reschedule = () => {
      const events = services.store.getSnapshot().events.map((e) => e.data);
      void scheduleFeedReminder(events, prefs.feedReminder);
    };
    reschedule();
    return services.store.subscribe(reschedule);
  }, [services, me?.role, hasFamily, prefs.feedReminder]);

  const value = useMemo<Omit<AppApi, 'sessionState'> | null>(() => {
    if (!services) return null;
    const { api, store, uploads, db, engine } = services;
    return {
      api,
      store,
      uploads,
      db,
      me,
      role: me?.role ?? null,
      label: me?.label ?? me?.user.displayName ?? '',
      prefs,
      serverUrl,
      syncStatus,
      async signIn(token, url) {
        const previousToken = api.token;
        const previousUrl = api.baseUrl;
        api.token = token;
        api.baseUrl = url;
        let next: MeResponse;
        try {
          next = await api.me();
        } catch (error) {
          api.token = previousToken;
          api.baseUrl = previousUrl;
          throw error;
        }
        setServerUrl(url);
        const owner = sessionOwner(next.user.id, next.family?.id ?? null);
        const previousOwner = await SecureStore.getItemAsync(OWNER_KEY);
        if (shouldClearLocalData(previousOwner, owner)) await wipeLocalData();
        await SecureStore.setItemAsync(TOKEN_KEY, token);
        await SecureStore.setItemAsync(SERVER_KEY, url);
        await persistMe(next);
      },
      async signOut() {
        await unregisterPushToken(api).catch(() => {});
        await api.logout().catch(() => {});
        await clearSession();
      },
      setMe: persistMe,
      refreshMe,
      async updatePrefs(patch) {
        if (!me) return;
        const next = { ...me.prefs, ...patch };
        await persistMe({ ...me, prefs: next });
        try {
          await api.updatePrefs(next);
        } catch {
          // 设置先在本机生效，下次刷新时再由服务端为准。
        }
      },
      syncNow: () => engine.syncNow(),
      async write(collection, data, id) {
        const recordId = id ?? Crypto.randomUUID();
        await store.write(collection, recordId, data);
        void engine.syncNow();
        return recordId;
      },
      async remove(id) {
        await store.remove(id);
        void engine.syncNow();
      },
    };
  }, [
    services,
    me,
    prefs,
    serverUrl,
    syncStatus,
    persistMe,
    clearSession,
    wipeLocalData,
    refreshMe,
  ]);

  // baby 从无到有时 sessionState 要更新。
  const [, forceRender] = useState(0);
  useEffect(() => {
    if (!services) return;
    let hadBaby = Boolean(services.store.getSnapshot().baby);
    return services.store.subscribe(() => {
      const hasBaby = Boolean(services.store.getSnapshot().baby);
      if (hasBaby !== hadBaby) {
        hadBaby = hasBaby;
        forceRender((n) => n + 1);
      }
    });
  }, [services]);

  if (!value || !booted) return <>{fallback}</>;
  const hasBaby = Boolean(services?.store.getSnapshot().baby);
  let sessionState: SessionState = 'signedOut';
  if (value.api.token && me) {
    if (!me.family) sessionState = 'noFamily';
    else if (hasBaby || me.role !== 'admin') sessionState = 'ready';
    // 换了新手机的管理员，同步完成前不知道有没有宝宝资料。这时让人填，
    // 会覆盖全家的出生时间。所以必须等第一次同步成功。
    else sessionState = hasSynced ? 'noBaby' : 'syncing';
  }
  return <AppContext.Provider value={{ ...value, sessionState }}>{children}</AppContext.Provider>;
}

function announceRemote(
  records: ServerRecord[],
  me: MeResponse | null,
  units: Units,
  banner: (initial: string, message: string) => void,
) {
  const now = Date.now();
  const fresh = records
    .filter((r) => !r.deleted && (r.collection === 'event' || r.collection === 'moment'))
    .filter((r) => now - ((r.data as { at?: number }).at ?? 0) < 3_600_000);
  const latest = fresh[fresh.length - 1];
  if (!latest) return;
  const author =
    me?.members.find((m) => m.userId === latest.createdBy)?.label ??
    (latest.data as { byName?: string }).byName ??
    '家人';
  const text =
    latest.collection === 'event'
      ? describeEvent(latest.data as EventData, now, units)
      : (latest.data as { title?: string }).title || '新的一刻';
  banner(author.slice(0, 1), `${author} 记录了 ${text}`);
}
