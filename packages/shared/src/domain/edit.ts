import type { MediaRef } from '../schemas';

/**
 * 弹层可能开了一会儿，这期间家人的修改可能已经同步过来。后写胜出是按整条记录的，
 * 所以这里只把用户真正改过的字段放到最新版本上，别的字段（包括新版本写入的未知字段）都不动。
 *
 * `edited` 里没有的字段算没改：弹层只认识自己的字段，不能因此清掉别的。要清空就写 `undefined`。
 */
export function mergeEdit<T extends object>(base: T, latest: T, edited: Partial<T>): T {
  const merged = { ...latest };
  for (const key of Object.keys(edited) as (keyof T)[]) {
    // 都来自同一份数据，字段顺序一致。判断错了也只是多写一次相同的值。
    if (JSON.stringify(edited[key]) !== JSON.stringify(base[key])) {
      merged[key] = edited[key] as T[keyof T];
    }
  }
  return merged;
}

/** 媒体列表按增删合并：弹层打开期间家人新加的文件不能因为这次保存消失。 */
export function mergeMediaEdit(
  base: readonly MediaRef[],
  latest: readonly MediaRef[],
  edited: readonly MediaRef[],
): MediaRef[] {
  const baseIds = new Set(base.map((m) => m.id));
  const editedIds = new Set(edited.map((m) => m.id));
  const kept = latest.filter((m) => !baseIds.has(m.id) || editedIds.has(m.id));
  const keptIds = new Set(kept.map((m) => m.id));
  return [...kept, ...edited.filter((m) => !baseIds.has(m.id) && !keptIds.has(m.id))];
}
