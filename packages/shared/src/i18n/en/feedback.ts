import type { Catalog } from '../zh';
import { plural } from './plural';

export const feedback: Catalog['feedback'] = {
  row: 'Send feedback',
  rowSub: 'Report a problem or share an idea',
  rowUnavailable: "This server doesn't support it yet",
  title: 'Send feedback',
  checking: 'Connecting to the server…',
  unavailableTitle: "Feedback isn't available",
  unavailableSub: "This server doesn't have feedback turned on.",
  publicNote:
    "What you write is posted on a public web page that anyone can see. Please don't include your baby's name, birthday, ID numbers, address or other private details.",
  privateNote:
    "What you write goes to the developers. Please don't include your baby's name, birthday, ID numbers, address or other private details.",
  attachmentsNote: (days) =>
    days
      ? `Photos and videos are not public. Only the developers can see them, and they are deleted ${days} days after sending.`
      : 'Photos and videos are not public. Only the developers can see them.',
  textOnlyNote: "This server only takes text. You can't add photos or videos.",
  placeholder: 'What happened? On which screen, after doing what?',
  counter: (n, max) => `${n} / ${max}`,
  pick: 'Photo / video',
  pickSub: (max) => `Up to ${max}, not public`,
  picking: 'Opening…',
  tooMany: (max) => `You can add up to ${max} attachments`,
  tooBig: (size) => `A file is too large. The maximum is ${size}`,
  unsupported: 'You can only add photos and videos',
  diagnosticsTitle: 'This is sent too',
  diagnosticsPublicTitle: 'This is made public too',
  appVersion: 'App version',
  system: 'System',
  language: 'Language',
  region: 'Region',
  noRegion: '—',
  diagnosticsNote: "Your email, account, family members and your baby's details are not sent.",
  send: 'Send',
  uploading: (done, total) => `Uploading attachments ${done} / ${total}`,
  sending: 'Sending…',
  sent: 'Sent. Thank you for the feedback',
  queued: "Received. It'll be sent automatically soon",
  failedKept: (reason) =>
    `Not sent: ${reason}. Your text and attachments are saved on this phone, so you can try again.`,
  draftRestored: "What you didn't get to send last time is still here.",
  history: 'Sent before',
  statusSent: 'Sent',
  statusQueued: 'Waiting to send',
  statusDraft: 'Not sent',
  attachmentCount: (n) => (n > 0 ? ` · ${plural(n, 'attachment', 'attachments')}` : ''),
  back: '‹ Family',
  backA11y: 'Back to Family',
  removeA11y: 'Remove this attachment',
};
