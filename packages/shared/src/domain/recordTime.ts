export type RecordTimeProblem = 'future' | 'end-future' | 'end-before-start';

export interface RecordTimeCheck {
  /** 不能保存。 */
  error: { code: RecordTimeProblem; message: string } | null;
  /** 可以保存，但值得看一眼。 */
  notice: string | null;
}

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/**
 * 修改和补记时的时间规则。
 *
 * 早于出生只提示，不拦截：
 * - 出生时间本身可能填错。拦截的话，家长半夜记不了，还得先去改档案。
 * - 孕期的 B 超照片、出生前写的信都是合理的回忆。
 * - 接种只有日期，落在当天中午，下午出生的宝宝当天打的针按时刻比会“早于出生”，
 *   所以 `dateOnly` 的记录按日历日比较。
 * 未来时间和结束早于开始一定是选错了，而且会让统计出错，所以拦截。
 *
 * 校验只放在录入时。服务端和同步不看这些：旧版本和手机时钟不准时写入的数据，不能因此被拒绝或丢掉。
 */
export function checkRecordTime(input: {
  at: number;
  endAt?: number;
  birthAt?: number;
  now: number;
  dateOnly?: boolean;
  subject?: 'event' | 'memory';
}): RecordTimeCheck {
  const { at, endAt, birthAt, now, dateOnly, subject = 'event' } = input;
  const fail = (code: RecordTimeProblem, message: string): RecordTimeCheck => ({
    error: { code, message },
    notice: null,
  });
  if (at > now) return fail('future', '这个时间还没到，选现在或更早的时间。');
  if (endAt !== undefined) {
    if (endAt > now) return fail('end-future', '醒来的时间还没到，选现在或更早的时间。');
    if (endAt < at) return fail('end-before-start', '醒来的时间不能早于入睡的时间。');
  }
  const beforeBirth =
    birthAt !== undefined && (dateOnly ? startOfDay(at) < startOfDay(birthAt) : at < birthAt);
  if (!beforeBirth) return { error: null, notice: null };
  return {
    error: null,
    notice:
      subject === 'memory'
        ? '这是出生前的日子，会按“出生前”显示。'
        : '这个时间比出生时间还早，确认没有选错再保存。',
  };
}
