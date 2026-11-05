import { describe, expect, it } from 'vitest';
import { type DeleteTarget, deleteConfirmText } from '../src/domain/deleteConfirm';
import { type Locale, withLocale } from '../src/i18n';
import type { EventData } from '../src/schemas';

const at = Date.UTC(2026, 10, 5, 1, 30);

const events: Record<EventData['type'], EventData> = {
  feed: { type: 'feed', at, ml: 90 },
  diaper: { type: 'diaper', at, kind: 'wee' },
  sleep: { type: 'sleep', at, endAt: at + 3_600_000 },
  temp: { type: 'temp', at, celsius: 37.2 },
  med: { type: 'med', at, name: 'Vitamin D', dose: '1 drop' },
  bath: { type: 'bath', at },
  solids: { type: 'solids', at, food: 'Pumpkin' },
  growth: { type: 'growth', at, weightKg: 4.2, lengthCm: 54 },
  vaccine: { type: 'vaccine', at, vaccineId: 'bcg', name: '卡介苗 BCG' },
};

const words: Record<Locale, Record<EventData['type'], string>> = {
  zh: {
    feed: '喂奶',
    diaper: '尿布',
    sleep: '睡眠',
    temp: '体温',
    med: '吃药',
    bath: '洗澡',
    solids: '辅食',
    growth: '身高体重',
    vaccine: '卡介苗',
  },
  en: {
    feed: 'feed',
    diaper: 'diaper',
    sleep: 'sleep',
    temp: 'temperature',
    med: 'medicine',
    bath: 'bath',
    solids: 'solids',
    growth: 'height and weight',
    vaccine: 'BCG',
  },
};

const others: DeleteTarget[] = [
  { kind: 'moment', title: 'First smile' },
  { kind: 'moment', title: '' },
  { kind: 'letter', title: 'Dear you' },
  { kind: 'letter', title: '' },
  { kind: 'document', name: 'Birth certificate' },
  { kind: 'documentFile', name: 'scan.pdf' },
  { kind: 'formula', name: 'TestFormula' },
  { kind: 'vaccinePlan', name: 'Flu Plan' },
  { kind: 'member', name: 'Mom' },
];

const all = (): DeleteTarget[] => [
  ...Object.values(events).map(
    (event): DeleteTarget => ({ kind: 'event', event, summary: 'Feed 90ml · 09:30' }),
  ),
  ...others,
];

describe('deleteConfirmText', () => {
  for (const locale of ['zh', 'en'] as const) {
    it(`${locale}：每种记录的标题都说清楚删的是哪一种`, () => {
      withLocale(locale, () => {
        const titles = new Set<string>();
        for (const [type, event] of Object.entries(events) as [EventData['type'], EventData][]) {
          const { title } = deleteConfirmText({ kind: 'event', event, summary: '' });
          expect(title.toLowerCase()).toContain(words[locale][type].toLowerCase());
          titles.add(title);
        }
        expect(titles.size).toBe(Object.keys(events).length);
      });
    });

    it(`${locale}：标题是问句，正文和按钮都不为空，不用感叹号`, () => {
      withLocale(locale, () => {
        for (const target of all()) {
          const text = deleteConfirmText(target);
          expect(text.title).toMatch(locale === 'zh' ? /？$/ : /\?$/);
          expect(text.body.length).toBeGreaterThan(0);
          expect(text.confirm.length).toBeGreaterThan(0);
          for (const part of Object.values(text)) expect(part).not.toMatch(/[!！]/);
        }
      });
    });
  }

  it('记录的正文先写这条记录本身，再说可以撤销', () => {
    const zh = withLocale('zh', () =>
      deleteConfirmText({ kind: 'event', event: events.feed, summary: '喂奶 90ml · 09:30' }),
    );
    expect(zh.body.startsWith('喂奶 90ml · 09:30')).toBe(true);
    expect(zh.body).toContain('撤销');
    const en = withLocale('en', () =>
      deleteConfirmText({ kind: 'event', event: events.feed, summary: 'Feed 90ml · 09:30' }),
    );
    expect(en.body.startsWith('Feed 90ml · 09:30')).toBe(true);
    expect(en.body.toLowerCase()).toContain('undo');
  });

  it('名字和标题原样写进标题，没有标题时用通用的说法', () => {
    withLocale('zh', () => {
      expect(deleteConfirmText({ kind: 'moment', title: '第一次笑' }).title).toContain('第一次笑');
      expect(deleteConfirmText({ kind: 'moment', title: '' }).title).toBe('删除这条回忆？');
      expect(deleteConfirmText({ kind: 'letter', title: '' }).title).toBe('删除这封信？');
      expect(deleteConfirmText({ kind: 'documentFile', name: 'scan.pdf' }).title).toContain(
        'scan.pdf',
      );
      expect(deleteConfirmText({ kind: 'formula', name: 'TestFormula' }).title).toContain(
        'TestFormula',
      );
      expect(deleteConfirmText({ kind: 'vaccinePlan', name: 'Flu Plan' }).title).toContain(
        'Flu Plan',
      );
      expect(deleteConfirmText({ kind: 'member', name: '妈妈' }).title).toContain('妈妈');
    });
    withLocale('en', () => {
      expect(deleteConfirmText({ kind: 'moment', title: '第一次笑' }).title).toContain('第一次笑');
      expect(deleteConfirmText({ kind: 'document', name: '出生证明' }).title).toContain('出生证明');
    });
  });

  it('移除和删除用不同的按钮文字', () => {
    withLocale('zh', () => {
      expect(deleteConfirmText({ kind: 'moment', title: '' }).confirm).toBe('删除');
      expect(deleteConfirmText({ kind: 'documentFile', name: 'a.pdf' }).confirm).toBe('移除');
      expect(deleteConfirmText({ kind: 'vaccinePlan', name: 'x' }).confirm).toBe('移除');
      expect(deleteConfirmText({ kind: 'member', name: '妈妈' }).confirm).toBe('移出家庭');
    });
  });

  it('英文不假定性别', () => {
    withLocale('en', () => {
      for (const target of all()) {
        const { title, body, confirm } = deleteConfirmText(target);
        expect(`${title} ${body} ${confirm}`).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
      }
    });
  });
});
