import type { EventData } from '../schemas';
import { formatDuration } from './age';

export const eventColors: Record<EventData['type'], string> = {
  feed: '#c0714f',
  diaper: '#c9a24a',
  sleep: '#7d8fb8',
  temp: '#b8645e',
  med: '#8a7a9e',
  bath: '#6f9aa0',
  solids: '#c9a24a',
  growth: '#6f9a6a',
  vaccine: '#6f9a6a',
};

const diaperLabels = { wee: '尿尿', poo: '便便', both: '尿尿 + 便便' } as const;

export function describeEvent(event: EventData, now: number): string {
  switch (event.type) {
    case 'feed':
      return `喂奶 ${event.ml}ml`;
    case 'diaper':
      return `换尿布 · ${diaperLabels[event.kind]}`;
    case 'sleep':
      return event.endAt
        ? `睡了 ${formatDuration(event.endAt - event.at)}`
        : `睡觉中 · 已 ${formatDuration(now - event.at)}`;
    case 'temp':
      return `体温 ${event.celsius.toFixed(1)}℃`;
    case 'med':
      return `吃药 · ${event.name}${event.dose ? ` ${event.dose}` : ''}`;
    case 'bath':
      return '洗澡';
    case 'solids':
      return `辅食 · ${event.food}`;
    case 'growth':
      return `体重 ${event.weightKg.toFixed(1)}kg · 身长 ${event.lengthCm.toFixed(1)}cm`;
    case 'vaccine':
      return `接种 ${event.name}`;
  }
}

export interface DaySummary {
  feeds: number;
  ml: number;
  diapers: number;
  wetDiapers: number;
  sleepMs: number;
}

/** 统计 `now` 往前 24 小时。跨越窗口起点的睡眠只算窗口内的部分。 */
export function summarize24h(events: readonly EventData[], now: number): DaySummary {
  const start = now - 86_400_000;
  const summary: DaySummary = { feeds: 0, ml: 0, diapers: 0, wetDiapers: 0, sleepMs: 0 };
  for (const e of events) {
    if (e.type === 'sleep') {
      const end = Math.min(e.endAt ?? now, now);
      const begin = Math.max(e.at, start);
      if (end > begin) summary.sleepMs += end - begin;
      continue;
    }
    if (e.at <= start || e.at > now) continue;
    if (e.type === 'feed') {
      summary.feeds += 1;
      summary.ml += e.ml;
    } else if (e.type === 'diaper') {
      summary.diapers += 1;
      if (e.kind !== 'poo') summary.wetDiapers += 1;
    }
  }
  return summary;
}

export function summaryText(s: DaySummary): string {
  return `喂奶 ${s.feeds} 次 · ${s.ml}ml　尿布 ${s.diapers}　睡 ${(s.sleepMs / 3_600_000).toFixed(1)}h`;
}
