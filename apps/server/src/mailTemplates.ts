import { EMAIL_CODE_TTL_MINUTES, type Locale } from '@xiaodouya/shared';
import type { MailMessage } from './mailer';

/** 所有邮件文字都在这里。服务端同时服务不同语言的人，语言由调用方明确传入。 */

const verifyText: Record<Locale, (code: string) => Omit<MailMessage, 'to'>> = {
  zh: (code) => ({
    subject: `小豆芽邮箱验证码：${code}`,
    text: [
      `你的邮箱验证码是：${code}`,
      '',
      `${EMAIL_CODE_TTL_MINUTES} 分钟内有效，以最新收到的一封为准。`,
      '如果不是你注册的，不用理会这封邮件。',
    ].join('\n'),
  }),
  en: (code) => ({
    subject: `Your Xiaodouya verification code: ${code}`,
    text: [
      `Your email verification code is: ${code}`,
      '',
      `It's valid for ${EMAIL_CODE_TTL_MINUTES} minutes. Only the latest email counts.`,
      "If you didn't sign up, you can ignore this email.",
    ].join('\n'),
  }),
};

const resetText: Record<Locale, (code: string) => Omit<MailMessage, 'to'>> = {
  zh: (code) => ({
    subject: `小豆芽重置密码验证码：${code}`,
    text: [
      `你正在重置小豆芽的密码，验证码是：${code}`,
      '',
      `${EMAIL_CODE_TTL_MINUTES} 分钟内有效，以最新收到的一封为准。不要把它告诉任何人。`,
      '如果不是你本人操作，不用理会这封邮件，你的密码不会改变。',
    ].join('\n'),
  }),
  en: (code) => ({
    subject: `Your Xiaodouya password reset code: ${code}`,
    text: [
      `You're resetting your Xiaodouya password. Your code is: ${code}`,
      '',
      `It's valid for ${EMAIL_CODE_TTL_MINUTES} minutes. Only the latest email counts. Don't share it with anyone.`,
      "If this wasn't you, you can ignore this email. Your password won't change.",
    ].join('\n'),
  }),
};

export function verifyEmailMail(to: string, code: string, locale: Locale = 'zh'): MailMessage {
  return { to, ...verifyText[locale](code) };
}

export function resetPasswordMail(to: string, code: string, locale: Locale = 'zh'): MailMessage {
  return { to, ...resetText[locale](code) };
}
