import type { UploadProgress } from './uploadQueue';

/**
 * 断网时服务再撑多久。Android 12 起 App 在后台不能启动前台服务，停了之后网络回来也起不来，
 * 而进电梯、切基站这种几十秒的断网很常见，所以不能一断网就停。太长又是白白常驻。
 */
export const OFFLINE_GRACE_MS = 10 * 60_000;
/**
 * 有任务但一直没有进展（比如服务端挂了），退避最长 5 分钟一次，再多也只是耗电。
 * 不能常驻：过了这么久就停，下次打开接着传。
 */
export const STALL_GRACE_MS = 30 * 60_000;

export interface ServiceInput {
  progress: Pick<UploadProgress, 'total' | 'waitingForWifi' | 'offline' | 'halted'>;
  now: number;
  /** 开始断网的时间，没断网时为 null。 */
  offlineSince: number | null;
  /** 上一次有字节发出或文件传完的时间。 */
  lastProgressAt: number;
}

/**
 * 前台服务该不该跑。只在真的能传时跑：传完、全部等 Wi-Fi、队列停了（退出登录、登录失效、到系统上限）都要马上停，
 * 通知也跟着消失。全部等 Wi-Fi 时停掉后，Wi-Fi 在后台回来也起不来，只能等下次打开，这是系统的限制。
 */
export function shouldRunUploadService(input: ServiceInput): boolean {
  const { progress, now, offlineSince, lastProgressAt } = input;
  if (progress.halted || progress.total === 0 || progress.waitingForWifi) return false;
  if (progress.offline) {
    return offlineSince !== null && now - offlineSince < OFFLINE_GRACE_MS;
  }
  return now - lastProgressAt < STALL_GRACE_MS;
}
