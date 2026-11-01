import { ageParts, formatDuration } from '../domain/age';
import { summarize24h } from '../domain/events';
import { estimateNextFeed, sleepState } from '../domain/feeding';
import {
  formatTemperatureRange,
  formatTemperatureThreshold,
  type TemperatureUnit,
} from '../domain/units';
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
  if (celsius >= 38 && ageMonths < 3) {
    return {
      level: 'urgent',
      note: '发烧，请尽快就医',
      hint: `3 个月以下的宝宝 ${threshold(38)} 及以上，请尽快就医。`,
    };
  }
  if (celsius >= 39 && ageMonths < 6) {
    return {
      level: 'urgent',
      note: '高烧，请尽快联系医生',
      hint: `6 个月以下的宝宝 ${threshold(39)} 及以上，请尽快联系医生。`,
    };
  }
  if (celsius >= 38) {
    return {
      level: 'fever',
      note: '发烧，注意观察',
      hint: '已经发烧了。请留意精神和吃奶情况，不舒服或持续不退请看医生。',
    };
  }
  if (celsius >= 37.5) {
    return {
      level: 'elevated',
      note: '偏高，注意观察',
      hint: '有点偏高。松松衣服，30 分钟后再量一次。',
    };
  }
  if (celsius < 36) {
    return ageMonths < 3
      ? {
          level: 'urgent',
          note: '体温过低，请尽快联系医生',
          hint: `体温低于 ${threshold(36)}。先给宝宝保暖，并尽快联系医生。`,
        }
      : {
          level: 'elevated',
          note: '偏低，注意观察',
          hint: '体温偏低。注意保暖，过一会儿再量一次；持续偏低或精神差请看医生。',
        };
  }
  if (celsius < 36.5) {
    return {
      level: 'elevated',
      note: '偏低，注意观察',
      hint: '有点偏低。给宝宝保暖，30 分钟后再量一次。',
    };
  }
  return {
    level: 'normal',
    note: '正常',
    hint: `正常范围（${formatTemperatureRange(36.5, 37.5, unit)}）。`,
  };
}

export type InsightTone = 'neutral' | 'attention';

export interface Insight {
  tone: InsightTone;
  text: string;
}

/** 至少连续记录这么久，才对数量下判断，否则分不清是“少”还是“还没开始记”。 */
const MIN_COVERAGE_MS = 20 * 3_600_000;

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
  const earliest = Math.min(...logged.map((e) => e.at));
  const hasFullDay = now - earliest >= MIN_COVERAGE_MS;

  const facts = [`过去 24 小时喂了 ${summary.feeds} 次`];
  if (estimate.isLearned) facts.push(`平均间隔 ${formatDuration(estimate.intervalMs)}`);
  const lead = `${facts.join('，')}。`;

  const sleepingText = sleeping
    ? `宝宝已经睡了 ${formatDuration(now - sleeping.at)}。醒来后一般会饿，可以先把奶准备好。`
    : null;
  const forgottenText = forgotten ? '睡眠计时还开着，是不是忘了点“醒了”？' : null;

  if (!hasFullDay) {
    return {
      tone: 'neutral',
      text: sleepingText ?? forgottenText ?? `${lead}记满一天后，我们再帮你看看规律。`,
    };
  }

  const { months, days } = ageParts(birthAt, now);
  const pastFirstDays = months > 0 || days >= 5;
  const concerns: string[] = [];
  if (months < 6 && summary.feeds < 6) concerns.push(`喂奶 ${summary.feeds} 次`);
  if (pastFirstDays && months < 6 && summary.wetDiapers < 6) {
    concerns.push(`湿尿布 ${summary.wetDiapers} 片`);
  }
  // 偏少的提醒优先于其他任何提示，不能被睡眠计时盖住。
  if (concerns.length > 0) {
    return {
      tone: 'attention',
      text: `${lead}${concerns.join('、')}比常见的少。如果不是漏记，又没精神或吃奶变少，建议问问医生。`,
    };
  }
  if (sleepingText || forgottenText) {
    return { tone: 'neutral', text: (sleepingText ?? forgottenText) as string };
  }
  return {
    tone: 'neutral',
    text: `${lead}湿尿布 ${summary.wetDiapers} 片。每个宝宝节奏不同，有疑问可以问问医生。`,
  };
}

export interface KnowledgeCard {
  title: string;
  body: string;
}

/** 按月龄展示的常识，内容保守、指向医生。 */
export function knowledgeForAge(months: number, unit: TemperatureUnit = 'c'): KnowledgeCard[] {
  const doctor: KnowledgeCard = {
    title: '什么时候要看医生',
    body: `3 个月以下的宝宝体温到 ${formatTemperatureThreshold(38, unit)} 或以上，要尽快去医院。吃奶明显变少、精神很差、呼吸急促也一样。`,
  };
  if (months < 3) {
    return [
      {
        title: '吃多少算够',
        body: '次数和奶量因宝宝和喂养方式而异。除了奶量，也看尿布：满 5 天后，每天大约 6 片以上湿尿布是常用参考。',
      },
      {
        title: '日夜颠倒是正常的',
        body: '这个阶段一天常睡 14–17 小时。白天让房间亮一点、多说话，夜里喂奶时少开灯少逗玩，慢慢就能分清白天黑夜。',
      },
      doctor,
    ];
  }
  if (months < 6) {
    return [
      {
        title: '开始有规律了',
        body: '这几个月喂奶和睡眠通常会更有规律。看看记录里的间隔，能帮你们安排一天。',
      },
      {
        title: '多趴一趴',
        body: '清醒、有人看着的时候多让宝宝趴一会儿，有助于练习抬头和翻身。睡觉时还是要仰睡。',
      },
      doctor,
    ];
  }
  if (months < 12) {
    return [
      {
        title: '可以开始辅食了',
        body: '大约 6 个月、能坐稳并对食物感兴趣时，可以和医生商量开始添加辅食，奶仍然是主要营养来源。',
      },
      {
        title: '小心误吞和磕碰',
        body: '宝宝开始到处爬了。把小物件、药品和清洁剂收好，插座和桌角也要留意。',
      },
      {
        title: '什么时候要看医生',
        body: '持续发烧、吃喝明显变少、尿量减少、精神很差或呼吸急促时，都建议尽快看医生。',
      },
    ];
  }
  return [
    {
      title: '慢慢学会自己吃',
      body: '可以和家人一起吃饭，让宝宝练习自己抓握。避免整颗坚果、葡萄等容易呛到的食物。',
    },
    {
      title: '多说话、多读绘本',
      body: '每天和宝宝说话、一起读绘本，是对语言发展最简单有效的帮助。',
    },
    {
      title: '什么时候要看医生',
      body: '持续发烧、吃喝明显变少、尿量减少、精神很差或呼吸急促时，都建议尽快看医生。',
    },
  ];
}
