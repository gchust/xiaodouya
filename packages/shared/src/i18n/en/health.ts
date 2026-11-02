import type { Catalog } from '../zh';
import { plural } from './plural';

/**
 * 和 zh/health.ts 逐句对应。“尽快就医”写 as soon as possible，不能弱化成 consider 或 may want to；
 * “请”对应 please，不增加也不减少医学内容。
 */
export const health: Catalog['health'] = {
  temp: {
    urgentFeverNote: 'Fever. Seek medical care as soon as possible',
    urgentFeverHint: (threshold) =>
      `For a baby under 3 months, ${threshold} or higher: please seek medical care as soon as possible.`,
    highFeverNote: 'High fever. Contact a doctor as soon as possible',
    highFeverHint: (threshold) =>
      `For a baby under 6 months, ${threshold} or higher: please contact a doctor as soon as possible.`,
    feverNote: 'Fever. Watch closely',
    feverHint:
      "This is a fever. Watch your baby's energy and feeding. See a doctor if your baby seems unwell or the fever doesn't go down.",
    elevatedNote: 'A bit high. Watch closely',
    elevatedHint: 'A little high. Loosen their clothing and measure again in 30 minutes.',
    tooLowNote: 'Too low. Contact a doctor as soon as possible',
    tooLowHint: (threshold) =>
      `Temperature is below ${threshold}. Keep your baby warm first, and contact a doctor as soon as possible.`,
    lowNote: 'A bit low. Watch closely',
    lowHint:
      'Temperature is low. Keep your baby warm and measure again in a little while. See a doctor if it stays low or your baby has low energy.',
    slightlyLowHint: 'A little low. Keep your baby warm and measure again in 30 minutes.',
    normalNote: 'Normal',
    normalHint: (range) => `Normal range (${range}).`,
  },
  insight: {
    feeds: (n) => `${plural(n, 'feed', 'feeds')} in the past 24 hours`,
    interval: (duration) => `average interval ${duration}`,
    lead: (facts) => `${facts.join(', ')}. `,
    sleeping: (duration) =>
      `Your baby has been asleep for ${duration}. Babies are usually hungry when they wake, so you could get a feed ready.`,
    forgotten: 'The sleep timer is still running. Did you forget to tap "Awake"?',
    noFullDay: (lead) =>
      `${lead}Once you've recorded a full day, we'll help you look for patterns.`,
    concernFeeds: (n) => plural(n, 'feed', 'feeds'),
    concernWet: (n) => plural(n, 'wet diaper', 'wet diapers'),
    concern: (lead, concerns) =>
      `${lead}Fewer than usual: ${concerns.join(', ')}. If nothing was left unrecorded and your baby has low energy or is feeding less, we suggest asking a doctor.`,
    fine: (lead, wet) =>
      `${lead}${plural(wet, 'wet diaper', 'wet diapers')}. Every baby has their own rhythm. If you have questions, you can ask a doctor.`,
  },
  knowledge: {
    doctorTitle: 'When to see a doctor',
    doctorUnder3Months: (threshold) =>
      `If a baby under 3 months has a temperature of ${threshold} or higher, go to a hospital as soon as possible. The same goes for feeding much less, very low energy, or fast breathing.`,
    doctorGeneral:
      'For a lasting fever, eating and drinking much less, fewer wet diapers, very low energy, or fast breathing, we suggest seeing a doctor as soon as possible.',
    enoughTitle: 'How much is enough',
    enoughBody:
      'The number of feeds and the amount vary by baby and by how you feed. Besides the amount, look at diapers too: after the first 5 days, about 6 or more wet diapers a day is a common reference.',
    dayNightTitle: 'Mixing up day and night is normal',
    dayNightBody:
      'At this stage babies often sleep 14–17 hours a day. Keep the room brighter and talk more during the day. At night, keep lights low and play less during feeds. They will slowly learn day from night.',
    rhythmTitle: 'A rhythm starts to form',
    rhythmBody:
      'Feeding and sleep usually become more regular in these months. Looking at the intervals in your records can help you plan the day.',
    tummyTitle: 'More tummy time',
    tummyBody:
      'When your baby is awake and someone is watching, give them more time on their tummy. It helps them practice lifting their head and rolling over. For sleep, they should still lie on their back.',
    solidsTitle: 'Solids can start',
    solidsBody:
      'At about 6 months, when your baby can sit steadily and is interested in food, you can talk with a doctor about starting solids. Milk is still the main source of nutrition.',
    safetyTitle: 'Watch for choking and bumps',
    safetyBody:
      'Your baby is starting to crawl everywhere. Put away small objects, medicines and cleaning products, and watch out for outlets and table corners.',
    selfFeedTitle: 'Learning to feed themselves',
    selfFeedBody:
      'Eat together as a family and let your baby practice grasping food. Avoid foods that are easy to choke on, such as whole nuts and grapes.',
    readTitle: 'Talk and read together',
    readBody:
      'Talking with your baby and reading picture books together every day is the simplest and most effective help for language development.',
  },
};
