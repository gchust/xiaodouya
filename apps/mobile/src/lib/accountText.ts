import { EMAIL_CODE_TTL_MINUTES } from '@xiaodouya/shared';

/** 账号相关的界面文字集中在这里，多语言时一起搬走。 */
export const accountText = {
  consentPrefix: '注册即表示同意',
  consentTerms: '《用户协议》',
  consentAnd: '和',
  consentPrivacy: '《隐私政策》',

  forgotLink: '忘记密码？',
  forgotDeployerNote: '忘记密码？这个 App 由你们家自己部署，请部署它的人在服务器上重置。',
  forgotTitle: '找回密码',
  forgotHint: '填写注册时用的邮箱，我们会发一个验证码过去。',
  forgotSubmit: '发送验证码',
  resetTitle: '设置新密码',
  resetHint: (email: string) =>
    `如果 ${email} 注册过，验证码已经发过去了，${EMAIL_CODE_TTL_MINUTES} 分钟内有效。`,
  resetCode: '6 位验证码',
  resetNewPassword: '新密码（至少 8 位）',
  resetSubmit: '更新密码',
  resetDone: '密码已更新，所有设备都需要重新登录。',

  verifyTitle: '验证邮箱',
  verifyHint: (email: string) =>
    `验证码会发到 ${email}，${EMAIL_CODE_TTL_MINUTES} 分钟内有效。忘记密码时要靠这个邮箱找回。`,
  verifySubmit: '验证',
  verifyResend: '重新发送验证码',
  verifyResendWait: (seconds: number) => `${seconds} 秒后可以重新发送`,
  verifySkip: '以后再说',
  verifySkipHint: '之后可以在「家人」的设置里验证。',
  verifyDone: '邮箱已验证',
  joinFailed: '加入家庭失败，可以重新填写邀请码',
  verifyRow: '验证邮箱',
  verifyRowSub: '忘记密码时要靠这个邮箱找回',

  exportRow: '导出家庭数据',
  exportRowBusy: '正在导出…',
  exportRowSub: '生成 JSON 文件，文件本身不包含照片和视频',
  exportDialog: '导出家庭数据',
  exportFailed: '导出失败，请稍后再试',

  deleteRow: '删除账号',
  deleteRowSub: '永久删除，无法恢复',
  deleteTitle: '删除账号',
  deleteBlocked:
    '你是这个家庭唯一的管理员。请先把另一位家人设为管理员，或者把其他家人都移出家庭，再删除账号。',
  deleteNoFamily: '你的账号和登录信息会被永久删除，无法恢复。',
  deleteLastMember:
    '你是这个家庭的最后一位成员。账号、宝宝资料、所有记录、回忆、照片、视频和证件都会被永久删除，无法恢复。需要留底的话，请先导出。',
  deleteLeave:
    '你的账号和登录信息会被永久删除，无法恢复。你记录的内容和上传的文件会留在家庭里，家人还能看到；内容里写过的称呼和文字不会改动。',
  deleteUnsynced: '这台手机上还有没传到服务器的内容，会一起丢失。',
  deletePassword: '输入密码确认',
  deleteConfirm: '永久删除账号',
  deleteDone: '账号已删除',
  deleteSessionGone: '登录已失效，手机上的数据已清除。如果账号还在，重新登录后可以再删除一次。',
} as const;
