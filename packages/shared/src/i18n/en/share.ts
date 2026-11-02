import type { Catalog } from '../zh';
import { plural } from './plural';

export const share: Catalog['share'] = {
  // ─── App ──────────────────────────────────────
  shareLink: 'Share this day',
  shareTodayLink: 'Share today',
  shareDayA11y: (date) => `Share records from ${date}`,
  sheetTitle: 'Share this day',
  counts: (records, moments, files) => {
    const parts = [
      records ? plural(records, 'record', 'records') : '',
      moments ? plural(moments, 'moment', 'moments') : '',
      files ? plural(files, 'file', 'files') : '',
    ].filter(Boolean);
    return parts.length ? `This day has ${parts.join(', ')}` : 'Nothing to show with these choices';
  },
  includeMoments: 'Moments, photos and videos',
  includeDaily: 'Daily records',
  includeDailySub: 'Feeds, diapers, sleep, solids, baths',
  includeHealth: 'Health records',
  includeHealthSub: 'Temperature, medicine, growth, vaccines',
  includeHealthOn: 'When this is on, they can see temperature, medicine, growth and vaccines.',
  ttlTitle: 'Link lasts',
  ttlDays: (days) => plural(days, 'day', 'days'),
  notice: 'Anyone with the link can see this. You can revoke it at any time.',
  create: 'Create link',
  creating: 'Creating…',
  nothingSelected: 'Choose at least one.',
  createdTitle: 'Link created',
  send: 'Send to someone',
  sendAgain: 'Send again',
  revokeThis: 'Revoke this link',
  shareMessage: (date, url) => `Baby's day, ${date}: ${url}`,
  pendingRecords: (count) =>
    count === 1
      ? "1 record hasn't reached the server yet, so the page won't show it for now. It will appear once this phone is online."
      : `${count} records haven't reached the server yet, so the page won't show them for now. They will appear once this phone is online.`,
  pendingFiles: (count) =>
    count === 1
      ? "1 photo or video is still uploading, so the page won't show it for now. It will appear when finished."
      : `${count} photos or videos are still uploading, so the page won't show them for now. They will appear when finished.`,
  offline:
    "You're offline, so the link can't be created. Your records are safe on this phone. Try again when you're connected.",
  createFailed: "Couldn't create the link. Please try again later.",
  linksRow: 'Shared links',
  linksRowSub: 'See which ones still open, and revoke at any time',
  linksEmpty: 'No active links right now.',
  linksFailed: "Couldn't load these. Please try again later.",
  linkLine: (expires, by) => `Expires ${expires} · created by ${by}`,
  revoke: 'Revoke',
  revokeQ: (date) => `Revoke the link for ${date}?`,
  revokeNote:
    "After this, opening the link won't show anything. A page that is already open can still show photos and videos for up to 1 hour.",
  revoked: 'Revoked',
  revokeFailed: "Couldn't revoke it. Please try again later.",
  // ─── 网页 ──────────────────────────────────────
  pageTitleBefore: (name, days) => `${name}, ${plural(Number(days), 'day', 'days')} before birth`,
  fallbackName: 'Baby',
  loading: 'Opening…',
  invalidTitle: 'This link has expired or was revoked',
  invalidBody: 'You could ask the person who sent it to share again.',
  errorTitle: "Couldn't open this",
  errorBody: 'The connection seems unsteady. Please try again.',
  busyBody: 'This has been opened a lot just now. Please try again in a little while.',
  retry: 'Try again',
  statFeeds: 'Feeds',
  statFeedsValue: (count) => String(count),
  statDiapers: 'Diapers',
  statDiapersValue: (count) => String(count),
  statSleep: 'Sleep',
  statSleepValue: (hours) => `${hours} hr`,
  photosTitle: 'Photos and videos',
  timelineTitle: 'The day',
  emptyTitle: 'Nothing here yet',
  emptyBody: 'Anything added to this day later will show up here.',
  milestone: 'Milestone',
  wroteBy: (name) => `Written by ${name}`,
  sleepNotEnded: 'Sleep · no end time recorded',
  omittedMedia: (count) =>
    count === 1
      ? "1 more file doesn't fit here. You could ask the person who shared this."
      : `${count} more files don't fit here. You could ask the person who shared this.`,
  mediaFailed: "Couldn't open this file",
  mediaRetry: 'Tap to try again',
  videoLabel: 'Video',
  audioLabel: 'Voice recording',
  openPhoto: 'View larger',
  closePhoto: 'Close',
  previousPhoto: 'Previous',
  nextPhoto: 'Next',
  footer: 'Xiaodouya · Baby journal',
  footerNote: 'A family shared this private page with you. Please do not forward it.',
};
