import { t } from '../i18n';
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
  if (at > now) return fail('future', t().domain.recordTime.future);
  if (endAt !== undefined) {
    if (endAt > now) return fail('end-future', t().domain.recordTime.endFuture);
    if (endAt < at) return fail('end-before-start', t().domain.recordTime.endBeforeStart);
  }
  const beforeBirth =
    birthAt !== undefined && (dateOnly ? startOfDay(at) < startOfDay(birthAt) : at < birthAt);
  if (!beforeBirth) return { error: null, notice: null };
  return {
    error: null,
    notice:
      subject === 'memory'
        ? t().domain.recordTime.memoryBeforeBirth
        : t().domain.recordTime.eventBeforeBirth,
  };
}
