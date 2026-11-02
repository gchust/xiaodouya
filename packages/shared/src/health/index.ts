import { ageParts, formatDuration } from '../domain/age';
import { summarize24h } from '../domain/events';
import { estimateNextFeed, sleepState } from '../domain/feeding';
import {
  formatTemperatureRange,
  formatTemperatureThreshold,
  type TemperatureUnit,
} from '../domain/units';
import { t } from '../i18n';
import type { EventData } from '../schemas';

/**
 * 健康提示规则。App 不是医疗器械：这里只做保守提示，宁可建议留意，也不在数据不足时安慰。
 *
 * 依据（修改前请复核，详见 docs/ARCHITECTURE.md 的“健康内容”）：
 * - 发烧：NICE NG143 traffic light：3 个月以下 ≥38℃ 属高风险，3–6 个月 ≥39℃ 属中风险。
 *   NHS "Fever in children" 也建议这两种情况尽快联系医生。
 * - 体温偏低：WHO Thermal Protection of the Newborn：36.5–37.5℃ 正常，36.0–36.4℃ 为轻度偏低，
 *   低于 36℃ 为中度低体温。NHS 孕产单位的家长手册建议新生儿低于 36℃ 时联系医护。
 * - 湿尿布：出生约 5 天后每天约 6 片以上，是奶量足够的常用参考。NHS；AAP。
 * - 喂奶次数：足月新生儿母乳每天约 8–12 次，配方奶约 6–8 次。AAP HealthyChildren。
 */

export type TempLevel = 'normal' | 'elevated' | 'fever' | 'urgent';

export interface TempAssessment {
  level: TempLevel;
  note: string;
  hint: string;
}

/** 判断永远用摄氏度，`unit` 只决定提示文字里阈值的写法（38℃ 就是 100.4°F）。 */
export function assessTemperature(
  celsius: number,
  ageMonths: number,
  unit: TemperatureUnit = 'c',
): TempAssessment {
  const threshold = (c: number) => formatTemperatureThreshold(c, unit);
  const text = t().health.temp;
  if (celsius >= 38 && ageMonths < 3) {
    return {
      level: 'urgent',
      note: text.urgentFeverNote,
      hint: text.urgentFeverHint(threshold(38)),
    };
  }
  if (celsius >= 39 && ageMonths < 6) {
    return {
      level: 'urgent',
      note: text.highFeverNote,
      hint: text.highFeverHint(threshold(39)),
    };
  }
  if (celsius >= 38) {
    return {
      level: 'fever',
      note: text.feverNote,
      hint: text.feverHint,
    };
  }
  if (celsius >= 37.5) {
    return {
      level: 'elevated',
      note: text.elevatedNote,
      hint: text.elevatedHint,
    };
  }
  if (celsius < 36) {
    return ageMonths < 3
      ? {
          level: 'urgent',
          note: text.tooLowNote,
          hint: text.tooLowHint(threshold(36)),
        }
      : {
          level: 'elevated',
          note: text.lowNote,
          hint: text.lowHint,
        };
  }
  if (celsius < 36.5) {
    return {
      level: 'elevated',
      note: text.lowNote,
      hint: text.slightlyLowHint,
    };
  }
  return {
    level: 'normal',
    note: text.normalNote,
    hint: text.normalHint(formatTemperatureRange(36.5, 37.5, unit)),
  };
}

export type InsightTone = 'neutral' | 'attention';

export interface Insight {
  tone: InsightTone;
  text: string;
}

/** 至少连续记录这么久，才对数量下判断，否则分不清是“少”还是“还没开始记”。 */
const MIN_COVERAGE_MS = 20 * 3_600_000;
/**
 * 可以补记以前的记录之后，“最早一条很久以前”不再说明这家人一直在记。
 * 要看大约一天前有没有在记日常；疫苗和身高体重本来就不是每天记的，常常是补的，不算。
 */
const COVERAGE_LOOKBACK_MS = 48 * 3_600_000;

export function todayInsight(
  events: readonly EventData[],
  birthAt: number,
  now: number,
): Insight | null {
  const logged = events.filter((e) => e.at <= now);
  if (logged.length === 0) return null;
  const sleepNow = sleepState(logged, now);
  const sleeping = sleepNow.status === 'asleep' ? sleepNow.sleep : null;
  const forgotten = sleepNow.status === 'forgotten' ? sleepNow.sleep : null;

  const summary = summarize24h(logged, now);
  const estimate = estimateNextFeed(logged, now);
  const hasFullDay = logged.some(
    (e) =>
      e.type !== 'vaccine' &&
      e.type !== 'growth' &&
      e.at >= birthAt &&
      now - e.at >= MIN_COVERAGE_MS &&
      now - e.at <= COVERAGE_LOOKBACK_MS,
  );

  const text = t().health.insight;
  const facts = [text.feeds(summary.feeds)];
  if (estimate.isLearned) facts.push(text.interval(formatDuration(estimate.intervalMs)));
  const lead = text.lead(facts);

  const sleepingText = sleeping ? text.sleeping(formatDuration(now - sleeping.at)) : null;
  const forgottenText = forgotten ? text.forgotten : null;

  if (!hasFullDay) {
    return {
      tone: 'neutral',
      text: sleepingText ?? forgottenText ?? text.noFullDay(lead),
    };
  }

  const { months, days } = ageParts(birthAt, now);
  const pastFirstDays = months > 0 || days >= 5;
  const concerns: string[] = [];
  if (months < 6 && summary.feeds < 6) concerns.push(text.concernFeeds(summary.feeds));
  if (pastFirstDays && months < 6 && summary.wetDiapers < 6) {
    concerns.push(text.concernWet(summary.wetDiapers));
  }
  // 偏少的提醒优先于其他任何提示，不能被睡眠计时盖住。
  if (concerns.length > 0) {
    return {
      tone: 'attention',
      text: text.concern(lead, concerns),
    };
  }
  if (sleepingText || forgottenText) {
    return { tone: 'neutral', text: (sleepingText ?? forgottenText) as string };
  }
  return {
    tone: 'neutral',
    text: text.fine(lead, summary.wetDiapers),
  };
}

export interface KnowledgeCard {
  title: string;
  body: string;
}

/** 按月龄展示的常识，内容保守、指向医生。 */
export function knowledgeForAge(months: number, unit: TemperatureUnit = 'c'): KnowledgeCard[] {
  const text = t().health.knowledge;
  const doctor: KnowledgeCard = {
    title: text.doctorTitle,
    body: text.doctorUnder3Months(formatTemperatureThreshold(38, unit)),
  };
  const doctorLater: KnowledgeCard = { title: text.doctorTitle, body: text.doctorGeneral };
  if (months < 3) {
    return [
      { title: text.enoughTitle, body: text.enoughBody },
      { title: text.dayNightTitle, body: text.dayNightBody },
      doctor,
    ];
  }
  if (months < 6) {
    return [
      { title: text.rhythmTitle, body: text.rhythmBody },
      { title: text.tummyTitle, body: text.tummyBody },
      doctor,
    ];
  }
  if (months < 12) {
    return [
      { title: text.solidsTitle, body: text.solidsBody },
      { title: text.safetyTitle, body: text.safetyBody },
      doctorLater,
    ];
  }
  return [
    { title: text.selfFeedTitle, body: text.selfFeedBody },
    { title: text.readTitle, body: text.readBody },
    doctorLater,
  ];
}
