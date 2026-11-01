import { describe, expect, it } from 'vitest';
import { accountDeletionOutcome, ResetPasswordRequest, VerifyEmailRequest } from '../src/account';

describe('删除账号的规则', () => {
  const me = 'me';
  it('不在任何家庭里', () => {
    expect(accountDeletionOutcome(me, [])).toBe('no_family');
  });
  it('最后一个成员，不管什么角色，家庭一起删', () => {
    expect(accountDeletionOutcome(me, [{ userId: me, role: 'admin' }])).toBe('delete_family');
    expect(accountDeletionOutcome(me, [{ userId: me, role: 'viewer' }])).toBe('delete_family');
  });
  it('唯一的管理员，还有别的家人：拦下', () => {
    for (const role of ['caregiver', 'viewer'] as const) {
      expect(
        accountDeletionOutcome(me, [
          { userId: me, role: 'admin' },
          { userId: 'other', role },
        ]),
      ).toBe('blocked_only_admin');
    }
  });
  it('还有别的管理员：可以走', () => {
    expect(
      accountDeletionOutcome(me, [
        { userId: me, role: 'admin' },
        { userId: 'other', role: 'admin' },
      ]),
    ).toBe('leave_family');
  });
  it('普通成员：可以走', () => {
    expect(
      accountDeletionOutcome(me, [
        { userId: me, role: 'caregiver' },
        { userId: 'other', role: 'admin' },
      ]),
    ).toBe('leave_family');
  });
});

describe('验证码格式', () => {
  it('必须正好是 6 位数字，首尾空格可以容忍', () => {
    expect(VerifyEmailRequest.safeParse({ code: '012345' }).success).toBe(true);
    expect(VerifyEmailRequest.safeParse({ code: ' 012345 ' }).data?.code).toBe('012345');
    for (const code of ['12345', '1234567', '12345a', '', '١٢٣٤٥٦']) {
      expect(VerifyEmailRequest.safeParse({ code }).success).toBe(false);
    }
  });
  it('新密码至少 8 位', () => {
    const base = { email: 'a@example.test', code: '123456' };
    expect(ResetPasswordRequest.safeParse({ ...base, newPassword: 'short' }).success).toBe(false);
    expect(ResetPasswordRequest.safeParse({ ...base, newPassword: '12345678' }).success).toBe(true);
  });
});
