import NetInfo from '@react-native-community/netinfo';
import {
  type Collection,
  type CollectionData,
  defaultPrefs,
  effectiveUnits,
  type MeResponse,
  type Prefs,
  type RegionDefinition,
  type Role,
  regionFor,
  type ServerRecord,
  t,
  type Units,
} from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  Fragment,
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
import { getCoreServices } from '../data/services';
import type { SqliteDb } from '../data/sqlite';
import type { RecordStore, Snapshot } from '../data/store';
import type { SyncEngine, SyncEvents, SyncStatus } from '../data/syncEngine';
import type { UploadQueue } from '../data/uploadQueue';
import { useFeedback } from '../ui/overlays';
import { clearWidgetAvatars } from '../widgets/avatarCache';
import { scheduleWidgetRefresh } from '../widgets/controller';
import { shouldOfferVerifyStep } from './accountLogic';
import { type Api, ApiFailure } from './api';
import { forgetUpdateDownloads } from './appUpdateRuntime';
import { DEFAULT_API_URL } from './config';
import { deviceTimezone } from './device';
import { clearDownloads } from './downloads';
import { clearFeedbackDraft } from './feedbackDraft';
import { applyLocale, deviceLanguageTag } from './locale';
import { clearHttpCache, clearLocalMedia } from './media';
import { scheduleFeedReminder, unregisterPushToken } from './notifications';
import { summarizeRemote } from './remoteSummary';
import { sessionOwner, shouldClearLocalData, timezoneToSync } from './sessionLogic';
import { ME_KEY, OWNER_KEY, SERVER_KEY, TOKEN_KEY } from './storedSession';
import { getUploadRuntime } from './uploadRuntime';

const SYNCED_KEY = 'synced';
/** 跳过邮箱验证的账号 id。 */
const VERIFY_SKIPPED_KEY = 'session.verifySkipped';
/** 注册时填的邀请码，等验证这一步结束再加入。App 被杀也不用重填。 */
const DEFERRED_INVITE_KEY = 'session.deferredInvite';

export type SessionState =
  | 'signedOut'
  | 'verifyEmail'
  | 'noFamily'
  | 'syncing'
  | 'noBaby'
  | 'ready';

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
  /** 删除账号并清除手机上的全部数据。密码错误、被拦下时抛错，什么都不动。 */
  deleteAccount(password: string): Promise<'deleted' | 'sessionGone'>;
  /** 注册时填了邀请码但要先验证邮箱：记下来，这一步结束后自动加入。 */
  deferInvite(code: string): Promise<void>;
  /** 邮箱验证这一步结束（验证成功时传新的身份，跳过时不传）。 */
  finishEmailStep(verified?: MeResponse): Promise<void>;
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
  if (!app) throw new Error('useApp must be used inside AppProvider');
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
  const [verifySkippedBy, setVerifySkippedBy] = useState<string | null>(null);
  const feedback = useFeedback();
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 旧版本留在 cache/http-cache 里的 /v1/me 等响应，升级后第一次打开就清掉。
      clearHttpCache();
      // 小工具的后台任务和界面在同一个 JS 运行环境，必须共用这一份，否则界面看不到小工具的写入。
      const { db, api, store, engine, syncEvents } = await getCoreServices();
      // 活得比界面长：从最近任务划掉后界面卸载了，上传还在继续，再打开时要接上同一个队列。
      const uploads = getUploadRuntime(db, api).queue;
      Object.assign(syncEvents, {
        onStatus: setSyncStatus,
        onRemote: (records: ServerRecord[]) => {
          const summary = summarizeRemote(records, {
            selfId: meRef.current?.user.id,
            members: meRef.current?.members ?? [],
            units: effectiveUnits(
              meRef.current?.prefs.units,
              store.getSnapshot().baby?.data.region,
            ),
            now: Date.now(),
          });
          if (summary) feedbackRef.current.banner(summary.initial, summary.message);
        },
        onRejected: (count: number) => feedbackRef.current.toast(t().ui.rejectedRecords(count)),
        onSynced: () => {
          setHasSynced(true);
          void db.setMeta(SYNCED_KEY, '1');
          scheduleWidgetRefresh();
        },
      } satisfies SyncEvents);
      const [token, savedServer, savedMe, skippedBy] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(SERVER_KEY),
        SecureStore.getItemAsync(ME_KEY),
        SecureStore.getItemAsync(VERIFY_SKIPPED_KEY),
      ]);
      api.baseUrl = savedServer ?? DEFAULT_API_URL;
      api.token = token;
      if (savedServer) setServerUrl(savedServer);
      const synced = await db.getMeta(SYNCED_KEY);
      if (cancelled) return;
      clearDownloads();
      setHasSynced(synced === '1');
      setVerifySkippedBy(skippedBy);
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
    services.uploads.reset();
    await services.store.clear();
    clearDownloads();
    await clearLocalMedia();
    // 小工具的头像缓存是宝宝的脸；小工具的称呼和开关在 meta 表里，上面的 store.clear() 已经清掉。
    clearWidgetAvatars();
    // 反馈的草稿和附件副本也是这个人的，可能拍到孩子。
    clearFeedbackDraft();
    // 已经排好的本机提醒不随数据消失，账号没了之后还会响。
    await scheduleFeedReminder([], false);
    // 自动下载新版本的设置在 meta 里，上面随 store.clear() 清掉了；下好没装的安装包也一起删。
    forgetUpdateDownloads();
    setHasSynced(false);
  }, [services]);

  // 主动退出和删除账号：清除一切。
  const clearSession = useCallback(async () => {
    stopServices();
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(ME_KEY);
    await SecureStore.deleteItemAsync(OWNER_KEY);
    await SecureStore.deleteItemAsync(VERIFY_SKIPPED_KEY);
    await SecureStore.deleteItemAsync(DEFERRED_INVITE_KEY);
    setVerifySkippedBy(null);
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

  // 记录、登录状态、角色或单位变了，桌面小工具都要跟着变。退出登录后这里也会把它清空。
  // biome-ignore lint/correctness/useExhaustiveDependencies: me 变化正是要触发刷新的原因。
  useEffect(() => {
    if (!services) return;
    scheduleWidgetRefresh();
    const unsubscribe = services.store.subscribe(scheduleWidgetRefresh);
    const appSub = AppState.addEventListener('change', scheduleWidgetRefresh);
    return () => {
      unsubscribe();
      appSub.remove();
    };
  }, [services, me]);

  // 启动同步、上传和网络监听。
  useEffect(() => {
    if (!services || !hasFamily) return;
    const { engine, uploads } = services;
    void uploads.load();
    void engine.start();
    const netSub = NetInfo.addEventListener((state) => {
      const online = state.isConnected !== false;
      engine.setOnline(online);
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
        console.warn('refreshing account info failed');
      }
    }
  }, [services, persistMe]);

  useEffect(() => {
    if (booted) void refreshMe();
  }, [booted, refreshMe]);

  const prefs = me?.prefs ?? defaultPrefs;

  // 用户可能在 App 开着时改系统语言，回到前台时重新读一次。
  const [deviceTag, setDeviceTag] = useState(deviceLanguageTag);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setDeviceTag(deviceLanguageTag());
    });
    return () => sub.remove();
  }, []);
  // 必须在渲染子组件之前定下来：下面所有组件渲染时都直接读当前语言。
  const locale = applyLocale(prefs.locale, deviceTag);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 语言变了要刷新小工具上的文字。
  useEffect(() => {
    if (booted) scheduleWidgetRefresh();
  }, [booted, locale]);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: 提醒文字是预先排好的，换语言后要重排。
  useEffect(() => {
    if (!services || me?.role === 'viewer' || !hasFamily) return;
    const reschedule = () => {
      const events = services.store.getSnapshot().events.map((e) => e.data);
      void scheduleFeedReminder(events, prefs.feedReminder);
    };
    reschedule();
    return services.store.subscribe(reschedule);
  }, [services, me?.role, hasFamily, prefs.feedReminder, locale]);

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
      async deleteAccount(password) {
        let result: 'deleted' | 'sessionGone' = 'deleted';
        try {
          await api.deleteAccount(password);
        } catch (error) {
          // 上一次请求可能已经删掉了账号，只是响应没回来。这时再也登录不了，
          // 不清的话别人家孩子的数据会一直留在这台手机上。用户本来也要清除，所以照常清。
          if (!(error instanceof ApiFailure) || error.code !== 'unauthenticated') throw error;
          result = 'sessionGone';
        }
        await clearSession();
        return result;
      },
      async deferInvite(code) {
        await SecureStore.setItemAsync(DEFERRED_INVITE_KEY, code);
      },
      async finishEmailStep(verified) {
        if (verified) {
          await persistMe(verified);
        } else if (me) {
          await SecureStore.setItemAsync(VERIFY_SKIPPED_KEY, me.user.id);
          setVerifySkippedBy(me.user.id);
        }
        const invite = await SecureStore.getItemAsync(DEFERRED_INVITE_KEY);
        if (!invite) return;
        await SecureStore.deleteItemAsync(DEFERRED_INVITE_KEY);
        try {
          await persistMe(await api.acceptInvite(invite));
        } catch (error) {
          // 比如邀请码过期了。接下来是建家庭的页面，那里可以重新填。
          feedbackRef.current.toast(
            error instanceof Error ? error.message : t().account.joinFailed,
          );
        }
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
    if (shouldOfferVerifyStep(me, verifySkippedBy)) sessionState = 'verifyEmail';
    else if (!me.family) sessionState = 'noFamily';
    else if (hasBaby || me.role !== 'admin') sessionState = 'ready';
    // 换了新手机的管理员，同步完成前不知道有没有宝宝资料。这时让人填，
    // 会覆盖全家的出生时间。所以必须等第一次同步成功。
    else sessionState = hasSynced ? 'noBaby' : 'syncing';
  }
  // 换语言时整棵界面重新挂载：文字都是渲染时读的，有的还在 useMemo 里，逐个找容易漏。
  // 导航状态在容器里，重新挂载后还在原来的页面。
  return (
    <AppContext.Provider value={{ ...value, sessionState }}>
      <Fragment key={locale}>{children}</Fragment>
    </AppContext.Provider>
  );
}
