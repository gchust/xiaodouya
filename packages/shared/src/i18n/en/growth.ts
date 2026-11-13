import type { Catalog } from '../zh';

export const growth: Catalog['growth'] = {
  title: 'Growth chart',
  add: '+ Record height & weight',
  addA11y: 'Record height and weight',
  measures: { weight: 'Weight', length: 'Length', head: 'Head' },
  tab: (measure, unit) => `${measure} (${unit})`,
  tabA11y: (measure) => `Show the ${measure.toLowerCase()} chart`,
  ageAxis: 'Months',
  percentile: {
    about: (p) => `about P${p}`,
    below: 'below P1',
    above: 'above P99',
  },
  birth: 'Birth',
  birthDay: 'Day of birth',
  point: (age, value, percentile) => [age, value, percentile].filter(Boolean).join(' · '),
  pointA11y: (age, value, percentile) => [age, value, percentile].filter(Boolean).join(', '),
  empty: {
    weight: 'Record a weight and it will be charted here.',
    length: 'Record a length and it will be charted here.',
    head: 'You can add head size when you record height and weight. It will be charted here.',
  },
  sexLabel: { female: 'girls', male: 'boys' },
  reference: (sex) =>
    `The light lines are the 3rd, 15th, 50th, 85th and 97th percentiles of the WHO Child Growth Standards (${sex}).`,
  disclaimer:
    "The curves are only a reference. For how your baby is growing, go by your doctor's judgment.",
  preterm: "If your baby was born early, follow your doctor's method.",
  noSex:
    'Add sex (for growth charts) in the birth profile to see the WHO reference lines and percentiles.',
  noSexLink: 'Add sex',
  heightBreak:
    'WHO uses length lying down before age 2 and height standing up after age 2, so the reference lines shift slightly at 2 years.',
  overAge:
    "These WHO standards end at age 5. After 5, only your baby's own line is drawn, with no percentile.",
  sexRow: 'Sex (for growth charts)',
  sexValue: { female: 'Girl', male: 'Boy' },
  sexUnset: 'Not set',
  sexNote:
    "Only used to pick the WHO girls' or boys' chart, nowhere else. You can leave it blank; the chart then shows only your baby's own measurements.",
  head: 'Head circumference',
  addHead: '+ Add head circumference (optional)',
  removeHead: 'Remove head circumference',
};
