/**
 * 上传速度：最近几秒的滑动平均。样本是“累计发出的字节”，只增不减。
 * 重传时字节会再发一遍，那也是真实的网络速度，所以回退的进度不进这里（见 UploadQueue.noteSent）。
 */
export interface SpeedSample {
  at: number;
  bytes: number;
}

/** 太短会跳来跳去，太长则网络变了很久才反应过来。 */
export const SPEED_WINDOW_MS = 8_000;
/** 刚开始时样本太少，算出来的数不可信，宁可不显示。 */
const MIN_SPAN_MS = 1_500;
/** 这么久没有新字节就不算在传了，显示状态而不是一个过时的数。 */
const STALL_MS = 5_000;

/** 加入一个样本并丢掉窗口外的。保留窗口外最后一个作为起点，平均才覆盖完整的窗口。 */
export function addSpeedSample(
  samples: readonly SpeedSample[],
  sample: SpeedSample,
  windowMs = SPEED_WINDOW_MS,
): SpeedSample[] {
  const next = [...samples, sample];
  let first = 0;
  while (first + 1 < next.length && (next[first + 1]?.at ?? 0) <= sample.at - windowMs) first++;
  return next.slice(first);
}

/** 字节每秒。没数据、刚开始、已经卡住时返回 null。 */
export function currentSpeed(
  samples: readonly SpeedSample[],
  now: number,
  { minSpanMs = MIN_SPAN_MS, stallMs = STALL_MS }: { minSpanMs?: number; stallMs?: number } = {},
): number | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || first === last) return null;
  if (now - last.at > stallMs) return null;
  // 分母算到“现在”而不是最后一个样本：速度掉下来时马上能看出来。
  const span = now - first.at;
  if (span < minSpanMs) return null;
  const bytes = last.bytes - first.bytes;
  return bytes > 0 ? (bytes * 1000) / span : null;
}

/** 预计还要多少秒。速度不可信时不猜。 */
export function etaSeconds(remainingBytes: number, speed: number | null): number | null {
  if (speed === null || speed <= 0) return null;
  return Math.max(0, Math.ceil(remainingBytes / speed));
}
