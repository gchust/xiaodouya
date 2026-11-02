import type { PublicMedia, PublicShareResponse } from '@xiaodouya/shared';

/** 明显虚构的数据。 */
export const FROM = Date.UTC(2026, 5, 14, 16);
export const TO = FROM + 24 * 3_600_000;

export const media = (overrides: Partial<PublicMedia> = {}): PublicMedia => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'image',
  url: 'https://files.fictional.test/original.jpg?X-Amz-Signature=a',
  thumbUrl: 'https://files.fictional.test/thumb.jpg?X-Amz-Signature=b',
  width: 400,
  height: 300,
  ...overrides,
});

export const share = (overrides: Partial<PublicShareResponse> = {}): PublicShareResponse => ({
  baby: { name: '测试豆', dayNumber: 15, age: { months: 0, days: 14 } },
  range: { fromAt: FROM, toAt: TO, timezone: 'Asia/Singapore' },
  units: { volume: 'ml', temperature: 'c', weight: 'kg', length: 'cm' },
  events: [
    { type: 'feed', at: FROM + 3_600_000, ml: 90, byName: '妈妈', note: '喝得快' },
    { type: 'diaper', at: FROM + 2 * 3_600_000, kind: 'wee' },
    { type: 'sleep', at: FROM + 3 * 3_600_000, endAt: FROM + 5 * 3_600_000 },
  ],
  moments: [
    {
      at: FROM + 4 * 3_600_000,
      title: '第一次抬头',
      text: '虚构的一段话',
      milestone: true,
      byName: '爸爸',
      media: [media()],
    },
  ],
  omittedMedia: 0,
  mediaExpiresIn: 3600,
  ...overrides,
});

export const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
