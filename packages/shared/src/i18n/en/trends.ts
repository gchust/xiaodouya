import type { Catalog } from '../zh';
import { plural } from './plural';

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const trends: Catalog['trends'] = {
  link: 'Trends ›',
  linkA11y: 'See trends for the last 7 and 30 days',
  title: 'Trends',
  range: (days) => `${days} days`,
  rangeA11y: (days) => `Show the last ${days} days`,
  dates: (from, to) => `${from} – ${to}`,
  note: "Counted by calendar day in your phone's time zone. Today isn't over yet, so it's lighter and left out of the daily average.",
  empty: 'No records in this period yet',
  emptySub: 'Once you log feeds, diapers and sleep, they will be lined up here by day.',
  today: 'Today',
  weekday: (date) => WEEKDAYS_SHORT[date.getDay()] ?? '',
  average: (value, days) => `${value} a day (${plural(Number(days), 'day', 'days')})`,
  feed: 'Feeds',
  feedCount: 'Count',
  feedTimes: (n) => `${n}`,
  feedAmount: (unit) => `Amount (${unit})`,
  amountNote: 'Breastfeeds and feeds without an amount count as feeds but not toward the amount.',
  sleep: 'Sleep',
  sleepTotal: 'Total per day (hours)',
  sleepHours: (hours) => `${hours} h`,
  sleepRhythm: 'Sleep through each day',
  rhythmOrder: 'The earliest day is at the top, today is at the bottom.',
  diaper: 'Diapers',
  wee: 'Wet',
  poo: 'Dirty',
  diaperAverage: (wee, poo) => `wet ${wee} · dirty ${poo}`,
  bothNote: '"Both" counts once as wet and once as dirty.',
  temp: 'Temperature',
  tempDay: (max, count) => `High ${max} · ${plural(Number(count), 'reading', 'readings')}`,
  tempNote: 'Only days with a temperature reading are listed.',
  dayA11y: (date, value) => `${date}: ${value}`,
  noRecord: 'No records',
};
