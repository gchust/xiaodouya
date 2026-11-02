import type { Catalog } from '../zh';

export const account: Catalog['account'] = {
  consentPrefix: 'By signing up you agree to the ',
  consentTerms: 'Terms of Use',
  consentAnd: ' and ',
  consentPrivacy: 'Privacy Policy',

  forgotLink: 'Forgot password?',
  forgotDeployerNote:
    'Forgot password? Your family runs this app on its own server, so ask whoever set it up to reset it on the server.',
  forgotTitle: 'Reset password',
  forgotHint: 'Enter the email you signed up with, and we will send a code.',
  forgotSubmit: 'Send code',
  resetTitle: 'Set a new password',
  resetHint: (email, minutes) =>
    `If ${email} is registered, a code has been sent. It's valid for ${minutes} minutes.`,
  resetCode: '6-digit code',
  resetNewPassword: 'New password (at least 8 characters)',
  resetSubmit: 'Update password',
  resetDone: 'Password updated. All devices need to sign in again.',

  verifyTitle: 'Verify email',
  verifyHint: (email, minutes) =>
    `The code will be sent to ${email} and is valid for ${minutes} minutes. If you forget your password, this email is how you get back in.`,
  verifySubmit: 'Verify',
  verifyResend: 'Resend code',
  verifyResendWait: (seconds) => `You can resend in ${seconds} s`,
  verifySkip: 'Not now',
  verifySkipHint: 'You can verify later in Family settings.',
  verifyDone: 'Email verified',
  joinFailed: "Couldn't join the family. You can enter the invite code again.",
  verifyRow: 'Verify email',
  verifyRowSub: 'If you forget your password, this email is how you get back in',

  exportRow: 'Export family data',
  exportRowBusy: 'Exporting…',
  exportRowSub: "Creates a JSON file. The file doesn't include photos or videos.",
  exportDialog: 'Export family data',
  exportFailed: 'Export failed. Please try again later.',

  deleteRow: 'Delete account',
  deleteRowSub: "Permanent. It can't be undone.",
  deleteTitle: 'Delete account',
  deleteBlocked:
    "You are this family's only admin. First make another family member an admin, or remove the other members, then delete your account.",
  deleteNoFamily:
    "Your account and sign-in details will be permanently deleted. This can't be undone.",
  deleteLastMember:
    "You are the last member of this family. Your account, baby profile, and all records, memories, photos, videos and documents will be permanently deleted. This can't be undone. If you want a copy, export first.",
  deleteLeave:
    "Your account and sign-in details will be permanently deleted. This can't be undone. What you recorded and uploaded stays with the family, and they can still see it. Names and text written in that content won't change.",
  deleteUnsynced: "This phone has content that hasn't reached the server. It will be lost too.",
  deletePassword: 'Enter your password to confirm',
  deleteConfirm: 'Permanently delete account',
  deleteDone: 'Account deleted',
  deleteSessionGone:
    'Your sign-in has expired, and the data on this phone has been cleared. If the account still exists, sign in again to delete it.',
};
