import { z } from 'zod';
import type { Collection, MediaScope, MediaVariant, Role } from './schemas';

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

export const DeleteAccountRequest = z.object({ password: z.string().min(1).max(200) });

export type AccountDeletionOutcome =
  /** 没有家庭，只删账号。 */
  | 'no_family'
  /** 家庭里唯一的管理员，还有别的家人：要先升别人为管理员或移出家人，否则家庭没人管了。 */
  | 'blocked_only_admin'
  /** 最后一个成员：家庭和全部数据一起删除。 */
  | 'delete_family'
  /** 只删自己，记录和文件留给家庭。 */
  | 'leave_family';

/** App 用它决定显示什么说明，服务端在事务里用它决定怎么删。规则只写这一份。 */
export function accountDeletionOutcome(
  userId: string,
  members: readonly { userId: string; role: Role }[],
): AccountDeletionOutcome {
  const me = members.find((m) => m.userId === userId);
  if (!me) return 'no_family';
  const others = members.filter((m) => m.userId !== userId);
  if (others.length === 0) return 'delete_family';
  if (me.role === 'admin' && !others.some((m) => m.role === 'admin')) return 'blocked_only_admin';
  return 'leave_family';
}

/** GET /v1/family/export 的内容。只放用户自己的数据：密钥、哈希、令牌、存储地址都不在这里。 */
export interface FamilyExport {
  format: 'xiaodouya-export';
  version: 1;
  exportedAt: number;
  account: { id: string; email: string; displayName: string };
  family: { id: string; name: string };
  role: Role;
  /** 不含别人的邮箱，和 /v1/me 给到的一样。 */
  members: { userId: string; label: string; role: Role }[];
  records: {
    id: string;
    collection: Collection;
    data: unknown;
    updatedAt: number;
    createdBy: string | null;
  }[];
  /** 只有文件信息，不含文件本身和下载地址。 */
  media: {
    id: string;
    variant: MediaVariant;
    scope: MediaScope;
    mime: string;
    size: number;
    filename: string | null;
    createdAt: number;
  }[];
}

export interface SendEmailCodeResponse {
  emailVerified: boolean;
  /** 多少秒后可以再次发送。0 表示不用再发。 */
  retryAfterSeconds: number;
}

/**
 * 建家庭时写给服务端的名字。界面上不显示，是数据不是文案，不随语言变。
 */
export const DEFAULT_FAMILY_NAME = '我们家';
