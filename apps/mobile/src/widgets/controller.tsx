import {
  buildWidgetView,
  effectiveUnits,
  type Prefs,
  type Role,
  startOfLocalDay,
  t,
  type WidgetAction,
  type WidgetSession,
  type WidgetView,
} from '@xiaodouya/shared';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { requestWidgetUpdate, type WidgetTaskHandlerProps } from 'react-native-android-widget';
import { type CoreServices, getCoreServices } from '../data/services';
import { LAST_SYNC_KEY, ROLE_KEY } from '../data/syncEngine';
import { DEFAULT_API_URL } from '../lib/config';
import { applyLocale } from '../lib/locale';
import { readStoredSession } from '../lib/storedSession';
import { runWidgetAction } from './actions';
import { renderWidgetFor, type WidgetFeedback, type WidgetName, widgetNames } from './views';

const REFRESH_DEBOUNCE_MS = 800;
/** “已记录”停留多久，这段时间按钮不会再记一条，防止手抖连点。 */
const FEEDBACK_MS = 5_000;
/** 后台任务的上限是 30 秒，同步不能占满。 */
const SYNC_LIMIT_MS = 15_000;
/** 系统定时刷新时，距离上次同步超过这么久才再同步，省电。 */
const STALE_SYNC_MS = 10 * 60_000;

const feedback = new Map<WidgetName, WidgetFeedback>();

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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

export async function loadWidgetView(core: CoreServices): Promise<WidgetView> {
  const { session, prefs } = await readSession(core);
  const { baby, events } = core.store.getSnapshot();
  const now = Date.now();
  const syncedAt = Number((await core.db.getMeta(LAST_SYNC_KEY)) ?? 0);
  return buildWidgetView({
    session,
    baby: baby?.data ?? null,
    entries: events,
    units: effectiveUnits(prefs?.units, baby?.data.region),
    now,
    dayStart: startOfLocalDay(now),
    syncedAt: syncedAt > 0 ? syncedAt : null,
  });
}

function isWidgetName(name: string): name is WidgetName {
  return (widgetNames as readonly string[]).includes(name);
}

/** 每次渲染都换一个新 id：下一次点击是新记录，而同一张画面上的连点仍然是同一条。 */
function renderCurrent(name: WidgetName, view: WidgetView) {
  return renderWidgetFor(name, view, Crypto.randomUUID(), feedback.get(name));
}

/** 重画桌面上所有小工具。没有放小工具时这里几乎没有开销。 */
export async function refreshWidgets(core?: CoreServices): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const services = core ?? (await getCoreServices());
    const view = await loadWidgetView(services);
    await Promise.all(
      widgetNames.map((widgetName) =>
        requestWidgetUpdate({
          widgetName,
          renderWidget: () => renderCurrent(widgetName, view),
        }),
      ),
    );
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

function feedbackTitle(action: WidgetAction, view: WidgetView): string {
  if (action.type === 'sleepStart') return t().widgetUi.sleepStarted;
  if (action.type === 'sleepEnd') return t().widgetUi.wokeLogged;
  return view.kind === 'ready' && view.lastFeedAmount
    ? t().widgetUi.feedLogged(view.lastFeedAmount)
    : t().records.logged;
}

export async function handleWidgetClick(
  name: string,
  action: WidgetAction,
  props: Pick<WidgetTaskHandlerProps, 'renderWidget'>,
): Promise<void> {
  const core = await getCoreServices();
  const { session } = await readSession(core);
  const plan = await runWidgetAction(action, core.store, session, Date.now());
  const view = await loadWidgetView(core);
  if (!isWidgetName(name)) return;
  if (plan.kind !== 'write') {
    // 没有写入（重复点击、状态已经变了、没有权限）：只把显示更新成现在的真实状态。
    props.renderWidget(renderCurrent(name, view));
    return;
  }
  feedback.set(name, { eventId: plan.id, title: feedbackTitle(action, view) });
  await refreshWidgets(core);
  // 先让用户看到“已记录”，再同步；同步慢或者没网都不影响这条记录已经存好。
  await Promise.all([delay(FEEDBACK_MS), syncInBackground(core).catch(() => {})]);
  feedback.delete(name);
  await refreshWidgets(core);
}

export async function handleWidgetTick(
  name: string,
  props: Pick<WidgetTaskHandlerProps, 'renderWidget'>,
): Promise<void> {
  const core = await getCoreServices();
  if (isWidgetName(name)) props.renderWidget(renderCurrent(name, await loadWidgetView(core)));
  const syncedAt = Number((await core.db.getMeta(LAST_SYNC_KEY)) ?? 0);
  if (Date.now() - syncedAt < STALE_SYNC_MS) return;
  await syncInBackground(core).catch(() => {});
  await refreshWidgets(core);
}
