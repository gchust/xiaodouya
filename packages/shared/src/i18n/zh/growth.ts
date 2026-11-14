/**
 * 生长曲线（F-148）。规则和来源在 health/growth.ts。
 * 健康内容：只写百分位，不评价好坏（不写“偏瘦”“正常”），两种语言的意思和数字必须一致
 * （i18n-content.test.ts）。改文案时两边一起改。
 */
export const growth = {
  title: '生长曲线',
  add: '＋ 记录身高体重',
  addA11y: '记录身高体重',
  measures: { weight: '体重', length: '身长', head: '头围' },
  tab: (measure: string, unit: string) => `${measure}（${unit}）`,
  tabA11y: (measure: string) => `看${measure}曲线`,
  ageAxis: '月龄',
  percentile: {
    about: (p: number) => `约 P${p}`,
    below: '低于 P1',
    above: '高于 P99',
  },
  birth: '出生',
  birthDay: '出生当天',
  /** 点开一个点：`3 个月零 12 天 · 6.2 kg · 约 P40`。没填性别时没有百分位。 */
  point: (age: string, value: string, percentile?: string) =>
    [age, value, percentile].filter(Boolean).join(' · '),
  pointA11y: (age: string, value: string, percentile?: string) =>
    [age, value, percentile].filter(Boolean).join('，'),
  empty: {
    weight: '记录一次体重，这里就会画出来。',
    length: '记录一次身长，这里就会画出来。',
    head: '记身高体重时可以顺便记头围，这里就会画出来。',
  },
  sexLabel: { female: '女孩', male: '男孩' },
  reference: (sex: string) =>
    `浅色的线是 WHO 儿童生长标准（${sex}）的第 3、15、50、85、97 百分位。`,
  disclaimer: '曲线只是参考，生长情况请以医生判断为准。',
  preterm: '早产的宝宝请按医生的方法看。',
  noSex: '在出生档案里填上性别（用于生长曲线），就能看到 WHO 的参考线和百分位。',
  noSexLink: '填写性别',
  heightBreak:
    'WHO 标准 2 岁前用躺着量的身长，2 岁后用站着量的身高，所以参考线在 2 岁处错开一小段。',
  overAge: 'WHO 这套标准只到 5 岁，5 岁以后只画宝宝自己的线，不说百分位。',
  sexRow: '性别（用于生长曲线）',
  sexValue: { female: '女孩', male: '男孩' },
  sexUnset: '不填',
  sexNote:
    '只用来选 WHO 生长曲线的女孩表或男孩表，别的地方不用。不填也可以，曲线只画宝宝自己的数据。',
  head: '头围',
  addHead: '＋ 记头围（选填）',
  removeHead: '不记头围',
};
