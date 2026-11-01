import { z } from 'zod';

export const EMAIL_CODE_LENGTH = 6;
export const EMAIL_CODE_TTL_MINUTES = 30;
/** 重新发送验证码要等多久。App 和服务端用同一个数。 */
export const EMAIL_CODE_COOLDOWN_SECONDS = 60;

const email = z.email().max(200);
const emailCode = z
  .string()
  .trim()
  .regex(new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`));

export const ForgotPasswordRequest = z.object({ email });
export const ResetPasswordRequest = z.object({
  email,
  code: emailCode,
  newPassword: z.string().min(8).max(200),
});
export const VerifyEmailRequest = z.object({ code: emailCode });

export interface SendEmailCodeResponse {
  emailVerified: boolean;
  /** 多少秒后可以再次发送。0 表示不用再发。 */
  retryAfterSeconds: number;
}
