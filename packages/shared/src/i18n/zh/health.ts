/**
 * 健康提示。规则和来源在 health/index.ts。
 * 两种语言的意思必须完全一致：阈值、月龄和紧迫程度都不能变。不要只改一种语言（见 health-i18n.test.ts）。
 */
export const health = {
  temp: {
    urgentFeverNote: '发烧，请尽快就医',
    urgentFeverHint: (threshold: string) => `3 个月以下的宝宝 ${threshold} 及以上，请尽快就医。`,
    highFeverNote: '高烧，请尽快联系医生',
    highFeverHint: (threshold: string) => `6 个月以下的宝宝 ${threshold} 及以上，请尽快联系医生。`,
    feverNote: '发烧，注意观察',
    feverHint: '已经发烧了。请留意精神和吃奶情况，不舒服或持续不退请看医生。',
    elevatedNote: '偏高，注意观察',
    elevatedHint: '有点偏高。松松衣服，30 分钟后再量一次。',
    tooLowNote: '体温过低，请尽快联系医生',
    tooLowHint: (threshold: string) => `体温低于 ${threshold}。先给宝宝保暖，并尽快联系医生。`,
    lowNote: '偏低，注意观察',
    lowHint: '体温偏低。注意保暖，过一会儿再量一次；持续偏低或精神差请看医生。',
    slightlyLowHint: '有点偏低。给宝宝保暖，30 分钟后再量一次。',
    normalNote: '正常',
    normalHint: (range: string) => `正常范围（${range}）。`,
  },
  insight: {
    feeds: (n: number) => `过去 24 小时喂了 ${n} 次`,
    interval: (duration: string) => `平均间隔 ${duration}`,
    lead: (facts: readonly string[]) => `${facts.join('，')}。`,
    sleeping: (duration: string) => `宝宝已经睡了 ${duration}。醒来后一般会饿，可以先把奶准备好。`,
    forgotten: '睡眠计时还开着，是不是忘了点“醒了”？',
    noFullDay: (lead: string) => `${lead}记满一天后，我们再帮你看看规律。`,
    concernFeeds: (n: number) => `喂奶 ${n} 次`,
    concernWet: (n: number) => `湿尿布 ${n} 片`,
    concern: (lead: string, concerns: readonly string[]) =>
      `${lead}${concerns.join('、')}比常见的少。如果不是漏记，又没精神或吃奶变少，建议问问医生。`,
    fine: (lead: string, wet: number) =>
      `${lead}湿尿布 ${wet} 片。每个宝宝节奏不同，有疑问可以问问医生。`,
  },
  knowledge: {
    doctorTitle: '什么时候要看医生',
    doctorUnder3Months: (threshold: string) =>
      `3 个月以下的宝宝体温到 ${threshold} 或以上，要尽快去医院。吃奶明显变少、精神很差、呼吸急促也一样。`,
    doctorGeneral: '持续发烧、吃喝明显变少、尿量减少、精神很差或呼吸急促时，都建议尽快看医生。',
    enoughTitle: '吃多少算够',
    enoughBody:
      '次数和奶量因宝宝和喂养方式而异。除了奶量，也看尿布：满 5 天后，每天大约 6 片以上湿尿布是常用参考。',
    dayNightTitle: '日夜颠倒是正常的',
    dayNightBody:
      '这个阶段一天常睡 14–17 小时。白天让房间亮一点、多说话，夜里喂奶时少开灯少逗玩，慢慢就能分清白天黑夜。',
    rhythmTitle: '开始有规律了',
    rhythmBody: '这几个月喂奶和睡眠通常会更有规律。看看记录里的间隔，能帮你们安排一天。',
    tummyTitle: '多趴一趴',
    tummyBody: '清醒、有人看着的时候多让宝宝趴一会儿，有助于练习抬头和翻身。睡觉时还是要仰睡。',
    solidsTitle: '可以开始辅食了',
    solidsBody:
      '大约 6 个月、能坐稳并对食物感兴趣时，可以和医生商量开始添加辅食，奶仍然是主要营养来源。',
    safetyTitle: '小心误吞和磕碰',
    safetyBody: '宝宝开始到处爬了。把小物件、药品和清洁剂收好，插座和桌角也要留意。',
    selfFeedTitle: '慢慢学会自己吃',
    selfFeedBody: '可以和家人一起吃饭，让宝宝练习自己抓握。避免整颗坚果、葡萄等容易呛到的食物。',
    readTitle: '多说话、多读绘本',
    readBody: '每天和宝宝说话、一起读绘本，是对语言发展最简单有效的帮助。',
  },
};
