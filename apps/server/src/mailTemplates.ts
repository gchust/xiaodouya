import { EMAIL_CODE_TTL_MINUTES } from '@xiaodouya/shared';
import type { MailMessage } from './mailer';

/** 所有邮件文字都在这里，以后做多语言只改这一个文件。 */

export function verifyEmailMail(to: string, code: string): MailMessage {
  return {
    to,
    subject: `小豆芽邮箱验证码：${code}`,
    text: [
      `你的邮箱验证码是：${code}`,
      '',
      `${EMAIL_CODE_TTL_MINUTES} 分钟内有效，以最新收到的一封为准。`,
      '如果不是你注册的，不用理会这封邮件。',
    ].join('\n'),
  };
}

export function resetPasswordMail(to: string, code: string): MailMessage {
  return {
    to,
    subject: `小豆芽重置密码验证码：${code}`,
    text: [
      `你正在重置小豆芽的密码，验证码是：${code}`,
      '',
      `${EMAIL_CODE_TTL_MINUTES} 分钟内有效，以最新收到的一封为准。不要把它告诉任何人。`,
      '如果不是你本人操作，不用理会这封邮件，你的密码不会改变。',
    ].join('\n'),
  };
}
