type Text = string | number;

/** 反馈问题：家人页设置里的一行和它打开的页面。 */
export const feedback = {
  row: '反馈问题',
  rowSub: '遇到问题或有想法，告诉开发者',
  rowUnavailable: '这台服务器暂不支持',
  title: '反馈问题',
  checking: '正在连接服务器…',
  unavailableTitle: '暂时不能反馈',
  unavailableSub: '这台服务器没有开启反馈功能。',
  publicNote:
    '你写的文字会发到一个公开的网页上，任何人都能看到。请不要写宝宝的名字、生日、证件号、住址这些隐私信息。',
  privateNote: '你写的文字会交给开发者。请不要写宝宝的名字、生日、证件号、住址这些隐私信息。',
  attachmentsNote: (days: number | null) =>
    days
      ? `照片和视频不公开，只有开发者能看，发出 ${days} 天后删除。`
      : '照片和视频不公开，只有开发者能看。',
  textOnlyNote: '这台服务器只收文字，不能加照片和视频。',
  placeholder: '发生了什么？在哪一页、做了什么之后？',
  counter: (n: Text, max: Text) => `${n} / ${max}`,
  pick: '照片 / 视频',
  pickSub: (max: Text) => `最多 ${max} 个，不公开`,
  picking: '正在打开…',
  tooMany: (max: Text) => `最多加 ${max} 个附件`,
  tooBig: (size: Text) => `有文件太大了，最大 ${size}`,
  unsupported: '只能加照片和视频',
  diagnosticsTitle: '这些信息也会一起发送',
  diagnosticsPublicTitle: '这些信息也会一起公开',
  appVersion: 'App 版本',
  system: '系统',
  language: '语言',
  region: '地区',
  noRegion: '—',
  diagnosticsNote: '不会发送你的邮箱、账号、家人和宝宝的信息。',
  send: '发送',
  uploading: (done: Text, total: Text) => `正在上传附件 ${done} / ${total}`,
  sending: '正在发送…',
  sent: '已发送，谢谢你的反馈',
  queued: '已收到，稍后会自动发出',
  failedKept: (reason: string) =>
    `没有发出去：${reason}。写的内容和附件都保存在手机上，可以再试一次。`,
  draftRestored: '上次没发出去的内容还在，可以接着发。',
  history: '你提交过的',
  statusSent: '已发送',
  statusQueued: '等待发送',
  statusDraft: '没有发出',
  attachmentCount: (n: number) => (n > 0 ? ` · ${n} 个附件` : ''),
  back: '‹ 家人',
  backA11y: '返回家人',
  removeA11y: '移除这个附件',
};
