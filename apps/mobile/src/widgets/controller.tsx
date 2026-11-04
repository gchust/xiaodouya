import {
  buildWidgetView,
  type DiaperKind,
  effectiveUnits,
  type Prefs,
  type Role,
  startOfLocalDay,
  t,
  type WidgetAction,
  type WidgetPlan,
  type WidgetSession,
  type WidgetView,
  widgetAvatarKey,
} from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import {
  requestWidgetUpdate,
  type WidgetInfo,
  type WidgetTaskHandlerProps,
} from 'react-native-android-widget';
import { type CoreServices, getCoreServices } from '../data/services';
import { LAST_SYNC_KEY, ROLE_KEY } from '../data/syncEngine';
import { DEFAULT_API_URL } from '../lib/config';
import { applyLocale } from '../lib/locale';
import { readStoredSession } from '../lib/storedSession';
import { runWidgetAction } from './actions';
import { readWidgetAvatar, updateWidgetAvatar } from './avatarCache';
import { createPendingTaps, idsWithPending } from './pending';
import { readWidgetPrefs } from './prefs';
import { createQueue } from './queue';
import {
  buttonOf,
  renderWidgetFor,
  type ShownWidgetView,
  type WidgetFeedback,
  type WidgetIds,
  type WidgetName,
  type WidgetSize,
  widgetNames,
} from './views';

const REFRESH_DEBOUNCE_MS = 800;
/**
 * “已记录”停留多久。这段时间被点的按钮换成“修改或撤销”，不会再记一条。5 秒够看清楚、
 * 够发现点错了去撤销；更长的话真的要接着记下一次时还得等。超过之后再点就是新的一条。
 */
const FEEDBACK_MS = 5_000;
/** 后台任务的上限是 30 秒，同步不能占满。 */
const SYNC_LIMIT_MS = 15_000;
/** 系统定时刷新时，距离上次同步超过这么久才再同步，省电。 */
const STALE_SYNC_MS = 10 * 60_000;

const feedback = new Map<WidgetName, WidgetFeedback>();
const pending = createPendingTaps();
/**
 * 最近一次算出来的显示。点击时先用它画“记录中…”，不用等读数据库；进程刚被拉起时没有，
 * 只能等数据读出来（这时大部分时间花在系统启动进程上，JS 这边帮不上）。
 */
let lastView: ShownWidgetView | null = null;
/** 写入、读数据、重画都排队，几个点击任务同时跑时画出来的也是一致的，见 `queue.ts`。 */
const queue = createQueue();

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 画完“记录中…”之后，同一个小工具至少隔这么久再画下一张。库每画一次就删掉上一张图片文件，
 * 桌面还没读完上一张时下一张就到了，小工具会整块空白一下（模拟器上 0.28 秒内连画两次时看到过，见 PITFALLS）。
 */
const PENDING_SETTLE_MS = 600;

async function settleAfter(pendingAt: number | null): Promise<void> {
  if (pendingAt === null) return;
  const wait = PENDING_SETTLE_MS - (Date.now() - pendingAt);
  if (wait > 0) await delay(wait);
}

async function readSession(core: CoreServices) {
  const { token, serverUrl, me } = await readStoredSession();
  // 可能是系统在 App 没开时拉起的，这时还没有 AppProvider 定下语言。
  applyLocale((me?.prefs as Prefs | undefined)?.locale);
  // 同步时发现角色变了会先写到本地，比缓存的账号信息新。任何一边说不能看，就不能看。
  const syncedRole = (await core.db.getMeta(ROLE_KEY)) as Role | null;
  const role = syncedRole === 'viewer' ? 'viewer' : (me?.role ?? null);
  const session: WidgetSession = {
    signedIn: Boolean(token && me),
    hasFamily: Boolean(me?.family),
    role,
    label: me?.label ?? me?.user?.displayName ?? '',
  };
  return { session, token, serverUrl, prefs: me?.prefs as Prefs | undefined };
}

export async function loadWidgetView(core: CoreServices): Promise<ShownWidgetView> {
  const { session, prefs } = await readSession(core);
  const { baby, events } = core.store.getSnapshot();
  const now = Date.now();
  const syncedAt = Number((await core.db.getMeta(LAST_SYNC_KEY)) ?? 0);
  const display = await readWidgetPrefs(core.db);
  const view = buildWidgetView({
    session,
    baby: baby?.data ?? null,
    entries: events,
    units: effectiveUnits(prefs?.units, baby?.data.region),
    now,
    dayStart: startOfLocalDay(now),
    syncedAt: syncedAt > 0 ? syncedAt : null,
    label: display.label,
  });
  if (view.kind !== 'ready') {
    lastView = view;
    return view;
  }
  // 只读本机已经准备好的文件，不联网；对不上现在的头像就不显示，见 avatarCache.ts。
  const key = widgetAvatarKey(display, baby?.data.avatar);
  const avatar = key ? await readWidgetAvatar(key) : null;
  lastView = avatar ? { ...view, avatar } : view;
  return lastView;
}

function isWidgetName(name: string): name is WidgetName {
  return (widgetNames as readonly string[]).includes(name);
}

/** 每次渲染都换一批新 id：下一次点击是新记录，而同一张画面上的连点仍然是同一条。 */
function newIds(): WidgetIds {
  return {
    feed: Crypto.randomUUID(),
    sleep: Crypto.randomUUID(),
    wee: Crypto.randomUUID(),
    poo: Crypto.randomUUID(),
    both: Crypto.randomUUID(),
  };
}

function sizeOf(info?: Pick<WidgetInfo, 'width' | 'height'>): WidgetSize | undefined {
  return info ? { width: info.width, height: info.height } : undefined;
}

function renderCurrent(name: WidgetName, view: WidgetView, info?: WidgetInfo) {
  const tap = pending.get(name, Date.now());
  return renderWidgetFor(
    name,
    view,
    idsWithPending(newIds(), tap),
    feedback.get(name),
    sizeOf(info),
    tap ? buttonOf(tap) : undefined,
  );
}

/** 只能在队列里调用。 */
async function renderAll(core: CoreServices): Promise<void> {
  const view = await loadWidgetView(core);
  await Promise.all(
    widgetNames.map((widgetName) =>
      requestWidgetUpdate({
        widgetName,
        renderWidget: (info) => renderCurrent(widgetName, view, info),
      }),
    ),
  );
}

/** 重画桌面上所有小工具。没有放小工具时这里几乎没有开销。 */
export async function refreshWidgets(core?: CoreServices): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const services = core ?? (await getCoreServices());
    await queue(() => renderAll(services));
  } catch {
    // 小工具刷新失败不能影响 App 本身，下一次写入或系统定时刷新会再试。
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** 合并短时间内的多次变化，同步一批记录时不用重画几百次。 */
export function scheduleWidgetRefresh(): void {
  if (Platform.OS !== 'android') return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshWidgets();
    // 头像换了、删了或者开关变了：先照旧画，准备好头像文件后再画一次，不让下载拖慢记录的显示。
    void getCoreServices()
      .then(updateWidgetAvatar)
      .then((changed) => (changed ? refreshWidgets() : undefined))
      .catch(() => {});
  }, REFRESH_DEBOUNCE_MS);
}

/** App 没开时也把数据推上去、把家人的记录拉下来。有界面时引擎本来就在跑，这里等于触发一轮。 */
async function syncInBackground(core: CoreServices): Promise<void> {
  const { token, serverUrl } = await readStoredSession();
  if (!token) return;
  core.api.token = token;
  core.api.baseUrl = serverUrl ?? DEFAULT_API_URL;
  await Promise.race([core.engine.syncOnce(), delay(SYNC_LIMIT_MS)]);
}

const diaperTitle = (kind: DiaperKind) =>
  kind === 'wee'
    ? t().records.diaperWet
    : kind === 'poo'
      ? t().records.diaperDirty
      : t().records.diaperBoth;

/** “已记好 · …”后面的那几个字。写入之后再取，喂奶的奶量就是刚记下的这条。 */
function feedbackTitle(action: WidgetAction, view: WidgetView): string {
  if (action.type === 'sleepStart') return t().widgetUi.fellAsleep;
  if (action.type === 'sleepEnd') return t().widgetUi.awake;
  if (action.type === 'diaper') return diaperTitle(action.kind);
  return view.kind === 'ready' && view.lastFeedAmount
    ? t().domain.events.feed(view.lastFeedAmount)
    : t().records.logged;
}

export async function handleWidgetClick(
  name: string,
  action: WidgetAction,
  props: Pick<WidgetTaskHandlerProps, 'renderWidget' | 'widgetInfo'>,
): Promise<void> {
  if (!isWidgetName(name)) {
    const core = await getCoreServices();
    const { session } = await readSession(core);
    await runWidgetAction(action, core.store, session, Date.now());
    return;
  }
  pending.start(name, action, Date.now());
  // 先画“记录中…”再做别的：读登录信息、写数据库都要时间，这段时间画面不变就会被再点一下。
  let pendingAt: number | null = null;
  if (lastView?.kind === 'ready') {
    props.renderWidget(renderCurrent(name, lastView, props.widgetInfo));
    pendingAt = Date.now();
  }
  let core: CoreServices;
  let plan: WidgetPlan;
  try {
    core = await getCoreServices();
    const { session } = await readSession(core);
    plan = await queue(async () => {
      const result = await runWidgetAction(action, core.store, session, Date.now());
      pending.finish(name, action);
      const view = await loadWidgetView(core);
      if (result.kind === 'write') {
        feedback.set(name, {
          eventId: result.id,
          title: feedbackTitle(action, view),
          at:
            result.data.type === 'sleep' && result.data.endAt ? result.data.endAt : result.data.at,
          button: buttonOf(action),
        });
      }
      if (result.kind !== 'write') {
        // 没有写入（重复点击、状态已经变了、没有权限）：只把显示更新成现在的真实状态。
        await settleAfter(pendingAt);
        props.renderWidget(renderCurrent(name, view, props.widgetInfo));
      }
      return result;
    });
  } catch (error) {
    // 没写成：放开按钮，下一次点击要能记上。重画交给 taskHandler。
    pending.finish(name, action);
    throw error;
  }
  if (plan.kind !== 'write') return;
  await settleAfter(pendingAt);
  await refreshWidgets(core);
  // 先让用户看到“已记录”，再同步；同步慢或者没网都不影响这条记录已经存好。
  await Promise.all([delay(FEEDBACK_MS), syncInBackground(core).catch(() => {})]);
  await queue(async () => {
    // 这几秒里又点了同一个小工具时，提示已经换成新的那条，不能把它删掉。
    if (feedback.get(name)?.eventId === plan.id) feedback.delete(name);
    await renderAll(core);
  }).catch(() => {});
}

export async function handleWidgetTick(
  name: string,
  props: Pick<WidgetTaskHandlerProps, 'renderWidget' | 'widgetInfo'>,
): Promise<void> {
  const core = await getCoreServices();
  if (isWidgetName(name)) {
    await queue(async () => {
      props.renderWidget(renderCurrent(name, await loadWidgetView(core), props.widgetInfo));
    });
  }
  const syncedAt = Number((await core.db.getMeta(LAST_SYNC_KEY)) ?? 0);
  if (Date.now() - syncedAt < STALE_SYNC_MS) return;
  await syncInBackground(core).catch(() => {});
  await refreshWidgets(core);
}
