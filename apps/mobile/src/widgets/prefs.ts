import { normalizeWidgetLabel, parseWidgetPrefs, type WidgetPrefs } from '@xiaodouya/shared';
import type { LocalDb } from '../data/store';

/**
 * 存在本机数据库的 meta 表里：小工具的后台任务本来就读这里，退出登录、删除账号、
 * 换账号登录时 `store.clear()` 连 meta 一起清掉，下一个人看不到上一个人起的称呼。
 */
export const WIDGET_PREFS_KEY = 'widget.prefs';

type MetaDb = Pick<LocalDb, 'getMeta' | 'setMeta'>;

export async function readWidgetPrefs(db: Pick<LocalDb, 'getMeta'>): Promise<WidgetPrefs> {
  return parseWidgetPrefs(await db.getMeta(WIDGET_PREFS_KEY));
}

let writing: Promise<unknown> = Promise.resolve();

/**
 * 只改传进来的项。称呼存规整过的，清空就是删掉这一项，回到宝宝的名字。
 * 先读后写，所以排队：边输入称呼边点开关时，后一次不能盖掉前一次。
 */
export function saveWidgetPrefs(
  db: MetaDb,
  patch: { label?: string | null; showAvatar?: boolean; babyId?: string | null },
): Promise<WidgetPrefs> {
  const run = writing.then(() => merge(db, patch));
  writing = run.catch(() => {});
  return run;
}

async function merge(
  db: MetaDb,
  patch: { label?: string | null; showAvatar?: boolean; babyId?: string | null },
): Promise<WidgetPrefs> {
  const next: WidgetPrefs = { ...(await readWidgetPrefs(db)) };
  if ('label' in patch) {
    const label = normalizeWidgetLabel(patch.label);
    if (label) next.label = label;
    else delete next.label;
  }
  if (patch.showAvatar !== undefined) next.showAvatar = patch.showAvatar;
  // null 是回到“跟着 App 里选的宝宝”。
  if (patch.babyId !== undefined) {
    if (patch.babyId) next.babyId = patch.babyId;
    else delete next.babyId;
  }
  await db.setMeta(WIDGET_PREFS_KEY, JSON.stringify(next));
  return next;
}
