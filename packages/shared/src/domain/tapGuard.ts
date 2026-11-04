/**
 * 记录按钮的防连点（issue #69）。从按下到画面变化有一段空白：App 里是写本地的几十毫秒，
 * 桌面小工具要等系统拉起后台任务，冷启动接近 2 秒。这段时间画面不变，人会以为没点上再点一下。
 *
 * - 正在写的时候，同一个按钮再点不算；
 * - 写好之后 `holdMs` 内再点也不算：画面刚变，这一下不是看到新画面之后有意点的；
 * - 写失败了马上放开，下一次点击要能记上，不能因为防连点丢了一条真实的记录；
 * - 一直没有结果（卡住）超过 `stuckMs` 也放开，按钮不能永远点不了。
 *
 * 只记在内存里：App 被杀之后自然清空，最坏是多记一条，用户能撤销；不会少记。
 */

/**
 * App 里写好之后再挡多久。Android 把 300 ms 内的第二下算作双击（`ViewConfiguration.getDoubleTapTimeout`），
 * 写本地还要几十毫秒，取 500 ms：手指连点的第二下落在这里面；看到按钮变了、Toast 出来再有意点一下，
 * 人的反应至少要 200 多毫秒再加上读字，基本都在这之后，不会被误挡。
 * 桌面小工具不用这个：它的“已记好”要停 5 秒（`FEEDBACK_MS`），按钮在这段时间本来就换成了“修改或撤销”。
 */
export const TAP_HOLD_MS = 500;

/** 卡住多久算卡住。写本地正常是几十毫秒，小工具的后台任务系统最多给 30 秒，这里取一个人等得住的上限。 */
export const TAP_STUCK_MS = 10_000;

export type TapStatus = 'idle' | 'pending' | 'done';

export interface TapGuardOptions {
  holdMs: number;
  stuckMs?: number;
}

type Entry = { token: number; status: 'pending' | 'done'; at: number };

export interface TapGuard {
  /** 这次点击要不要处理。要处理就返回一个凭据，写完用它报告结果；不处理返回 `null`。 */
  begin(key: string, now: number): number | null;
  succeed(key: string, token: number | null, now: number): void;
  fail(key: string, token: number | null): void;
  status(key: string, now: number): TapStatus;
}

export function createTapGuard({ holdMs, stuckMs = TAP_STUCK_MS }: TapGuardOptions): TapGuard {
  const entries = new Map<string, Entry>();
  let nextToken = 1;

  const status = (key: string, now: number): TapStatus => {
    const entry = entries.get(key);
    if (!entry) return 'idle';
    if (entry.status === 'pending') return now - entry.at < stuckMs ? 'pending' : 'idle';
    return now - entry.at < holdMs ? 'done' : 'idle';
  };

  // 凭据对不上说明这一次已经因为卡住被放开、又开始了新的一次，迟到的结果不能改掉新一次的状态。
  const current = (key: string, token: number | null) => {
    const entry = entries.get(key);
    return entry && token !== null && entry.token === token ? entry : null;
  };

  return {
    begin(key, now) {
      if (status(key, now) !== 'idle') return null;
      const token = nextToken++;
      entries.set(key, { token, status: 'pending', at: now });
      return token;
    },
    succeed(key, token, now) {
      const entry = current(key, token);
      if (entry) entries.set(key, { token: entry.token, status: 'done', at: now });
    },
    fail(key, token) {
      if (current(key, token)) entries.delete(key);
    },
    status,
  };
}

/** 包一层：被挡下的点击不跑 `task`；失败时放开并把错误原样抛出，调用方照常处理。 */
export async function guardTap<T>(
  guard: TapGuard,
  key: string,
  now: () => number,
  task: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const token = guard.begin(key, now());
  if (token === null) return { ran: false };
  try {
    const value = await task();
    guard.succeed(key, token, now());
    return { ran: true, value };
  } catch (error) {
    guard.fail(key, token);
    throw error;
  }
}
