import type { Config } from './config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

const RESEND_TIMEOUT_MS = 10_000;

/**
 * 用 HTTPS API 而不是 SMTP：Edge Function 不能开 25/465/587 这些端口。
 * 报错只带状态码：对方的响应可能回显收件人和正文，而错误信息会进日志。
 */
export function resendMailer(
  apiKey: string,
  from: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Mailer {
  return {
    async send({ to, subject, text }) {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to, subject, text }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Resend 返回 HTTP ${response.status}`);
    },
  };
}

/** 只用于本地开发，loadConfig 在生产环境会拒绝。这是唯一会把验证码打出来的地方。 */
export function logMailer(): Mailer {
  return {
    async send({ to, subject, text }) {
      console.log(`[开发邮件] 收件人：${to}\n主题：${subject}\n${text}`);
    },
  };
}

export function createMailer(mail: Config['mail']): Mailer | null {
  if (!mail) return null;
  return mail.provider === 'resend' ? resendMailer(mail.apiKey, mail.from) : logMailer();
}
