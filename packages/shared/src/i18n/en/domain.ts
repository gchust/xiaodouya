import type { Catalog } from '../zh';
import { MONTHS, plural, WEEKDAYS } from './plural';

const shortDate = (date: Date) => `${MONTHS[date.getMonth()]} ${date.getDate()}`;

export const domain: Catalog['domain'] = {
  medicineSuggestions: ['Vitamin D', 'Probiotic', 'Fever reducer'],
  time: {
    dayNumber: (day) => `Day ${day}`,
    daysBeforeBirth: (days) => `${days} ${days === 1 ? 'day' : 'days'} before birth`,
    notBorn: 'Not born yet',
    bornToday: 'Born today',
    days: (days) => plural(days, 'day', 'days'),
    months: (months) => plural(months, 'month', 'months'),
    monthsDays: (months, days) =>
      `${plural(months, 'month', 'months')} ${plural(days, 'day', 'days')}`,
    years: (years) => plural(years, 'year', 'years'),
    yearsMonths: (years, months) =>
      `${plural(years, 'year', 'years')} ${plural(months, 'month', 'months')}`,
    // 缩写不用分单复数，放得进小工具和时间线。
    duration: (hours, minutes) =>
      !hours ? `${minutes} min` : minutes ? `${hours} hr ${minutes} min` : `${hours} hr`,
    monthDay: shortDate,
    fullDate: (date) => `${shortDate(date)}, ${date.getFullYear()}`,
    dateHeader: (date) => `${shortDate(date)} · ${WEEKDAYS[date.getDay()]}`,
    shortDate,
  },
  events: {
    wee: 'Wet',
    poo: 'Dirty',
    both: 'Wet + dirty',
    feed: (amount) => `Feed ${amount}`,
    diaper: (kind) => `Diaper · ${kind}`,
    slept: (duration) => `Slept ${duration}`,
    sleeping: (duration) => `Asleep · ${duration} so far`,
    temp: (value) => `Temp ${value}`,
    med: (name, dose) => `Medicine · ${name}${dose ? ` ${dose}` : ''}`,
    bath: 'Bath',
    solids: (food) => `Solids · ${food}`,
    growth: (weight, length) => `Weight ${weight} · Length ${length}`,
    vaccine: (name) => `Vaccine: ${name}`,
    summary: (feeds, volume, diapers, sleepHours) =>
      `${plural(feeds, 'feed', 'feeds')} · ${volume}   ${plural(diapers, 'diaper', 'diapers')}   Slept ${sleepHours}h`,
    summaryMixed: (feeds, feedParts, diapers, sleepHours) =>
      `${plural(feeds, 'feed', 'feeds')} · ${feedParts.join(' · ')}   ${plural(diapers, 'diaper', 'diapers')}   Slept ${sleepHours}h`,
    bottlePart: (volume) => `Bottle ${volume}`,
    breastPart: (duration) => `Breast ${duration}`,
    breastOnly: 'Breast',
    breastFeed: (parts) => (parts ? `Breastfed · ${parts}` : 'Breastfed'),
    breastFeeding: (detail) => `Breastfeeding · ${detail}`,
    breastSideMinutes: (side, minutes) => `${side === 'left' ? 'L' : 'R'} ${minutes} min`,
    breastSide: (side) => (side === 'left' ? 'left side' : 'right side'),
    nextBreastSide: (side) => `Start on the ${side} side next time`,
  },
  units: {
    ml: 'milliliters',
    oz: 'ounces',
    c: 'degrees Celsius',
    f: 'degrees Fahrenheit',
    kg: 'kilograms',
    lb: 'pounds',
    cm: 'centimeters',
    in: 'inches',
    badWeight: (unit) => `That weight doesn't look right. The unit is ${unit}.`,
    badLength: (unit) => `That length doesn't look right. The unit is ${unit}.`,
  },
  recordTime: {
    future: "That time hasn't happened yet. Choose now or earlier.",
    endFuture: "That wake-up time hasn't happened yet. Choose now or earlier.",
    endBeforeStart: "The wake-up time can't be earlier than the time they fell asleep.",
    memoryBeforeBirth: 'This date is before birth, so it will show as "before birth".',
    eventBeforeBirth: 'This time is earlier than the birth time. Check it before saving.',
  },
  storage: {
    full: (quota) =>
      `Storage is full (${quota} in total), so new photos and videos can't be uploaded. Delete some memories or documents you don't need, then tap Retry.`,
    nearlyFull: (percent) =>
      `Storage is almost full: ${percent}% used. Once it's full, new files can't be uploaded.`,
    otherProvider: 'S3-compatible storage',
  },
  roles: {
    admin: 'Admin',
    caregiver: 'Can record',
    viewer: 'Memories and photos only',
  },
  widget: {
    signedOut: 'Sign in to record here',
    noFamily: 'Join a family to record here',
    noAccess: "This account can't see records. Open the app to see memories.",
    noBaby: 'No baby profile yet. Open the app to add one.',
    notSynced: 'Not synced',
    syncedAt: (clock) => `Synced ${clock}`,
    syncedOn: (date) => `Synced ${shortDate(date)}`,
  },
  vaccine: {
    selfAdded: 'Added by you',
    selfAddedAt: (when) => `${when} · Added by you`,
    birth: 'Birth',
    months: (months) => plural(months, 'month', 'months'),
    doneOn: (date) => `Given ${date}`,
    givenDoses: (count, date) => `${count} doses given · last ${date}`,
    plannedOn: (date) => `Planned ${date}`,
    askDoctor: 'Ask your doctor',
    depends: 'Depends',
    canBook: 'Can book now',
    timeTbd: 'Date to be set',
    notYet: 'Not yet',
    reminderWhen: (age) => `recommended age: ${age}`,
    usuallyFrom: (age) => `Usually started from ${age}`,
    reminder: (name, when) =>
      `${name}, ${when}. Tap here after the shot to record it in the vaccine book.`,
  },
  nutrition: {
    energyKcal: 'Energy',
    proteinG: 'Protein',
    fatG: 'Fat',
    carbsG: 'Carbohydrate',
    calciumMg: 'Calcium',
    ironMg: 'Iron',
    vitaminDUg: 'Vitamin D',
    needName: 'Give this formula a name',
    badNumber: (label) => `The number for ${label} doesn't look right`,
    badRatio: "The mixing ratio doesn't look right. Check the mixing table on the can.",
    noFeeds: 'No feeds recorded on this day',
    unmarked: (n) =>
      `${plural(n, 'feed has', 'feeds have')} no milk type, so ${n === 1 ? 'it was' : 'they were'} not counted`,
    noFormula: (n) =>
      `${plural(n, 'feed has', 'feeds have')} no formula selected, so ${n === 1 ? 'it was' : 'they were'} not counted`,
    breast: (n) =>
      `${plural(n, 'feed was', 'feeds were')} breast milk. Its nutrients can't be estimated, so ${n === 1 ? 'it was' : 'they were'} not counted`,
    mixed: (n) =>
      `${plural(n, 'feed was', 'feeds were')} mixed and can't be estimated, so ${n === 1 ? 'it was' : 'they were'} not counted`,
    breastfed: (n) =>
      `${plural(n, 'feed was', 'feeds were')} at the breast. How much was drunk can't be known, so ${n === 1 ? 'it was' : 'they were'} not counted`,
    noData: (n) =>
      `${plural(n, 'feed used', 'feeds used')} a formula with no nutrition data, so ${n === 1 ? 'it was' : 'they were'} not counted`,
    thinCount: (n) =>
      `Only ${plural(n, 'feed was', 'feeds were')} recorded on this day. Some may be missing, so there is no conclusion.`,
    thinSpan:
      'The feeds on this day were recorded too close together. Some may be missing, so there is no conclusion.',
    missingField: (n) => `${plural(n, 'feed used', 'feeds used')} a formula without this value`,
    insufficient: 'Not enough data',
    noReference: 'Not compared',
    progress: (percent) => `${percent}% so far`,
    met: 'Reached reference',
    below: 'Below reference',
    solidsNote: "Solids aren't counted, so milk alone can't show that it's not enough",
    medNote: "Medicine was recorded on this day. Supplements aren't counted",
    entryUncounted: (n) => `Not enough data · ${plural(n, 'feed', 'feeds')} not counted`,
    entryProgress: (label, percent) => `${label} ${percent}% so far`,
    entryIntakeOnly: 'Intake only',
    countedPrefix: 'Counted ',
    reference: (head, target) => `${head} / reference ${target}`,
    fallbackNote: (reason) => `${reason}. US IOM / NIH reference amounts are used for now.`,
  },
};
