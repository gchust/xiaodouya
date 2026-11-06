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
  sendToTitle: 'Send to',
  sendTo: (app) => `Send to ${app}`,
  more: 'More',
  moreA11y: 'Send with another app',
  copy: 'Copy link',
  copied: 'Copied',
  sendFailed: "Couldn't open that app. Try More, or copy the link.",
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
  // ─── 分享时间线（App） ─────────────────────────
  shareTimelineLink: 'Share timeline',
  shareTimelineA11y: 'Share moments from a period of time',
  timelineSheetTitle: 'Share timeline',
  timelineRangeWeek: 'Last 7 days',
  timelineRangeMonth: 'Last 30 days',
  timelineRangeAll: 'All',
  timelineRangeCustom: 'Custom',
  timelineFrom: 'From',
  timelineTo: 'To',
  timelineBadRange: 'The start date needs to be before the end date.',
  timelineCounts: (moments, files) =>
    moments
      ? `This period has ${plural(moments, 'moment', 'moments')}${files ? `, ${plural(files, 'file', 'files')}` : ''}`
      : 'No moments in this period yet',
  timelineWhat:
    "They can see every moment in this period: text, milestones, photos, videos and recordings, including any added to this period later. Feeds, diapers, sleep and other records, health records, letters to your baby and the time of birth aren't included.",
  timelineLocation:
    'Photos are shared as compressed previews without the location they were taken. Videos, recordings and older photos without a preview are the original files and can include where they were taken.',
  timelineShareMessage: (range, url) => `Baby's timeline, ${range}: ${url}`,
  linkTitleDay: (date) => `Day · ${date}`,
  linkTitleTimeline: (range) => `Timeline · ${range}`,
  rangeText: (from, to) => `${from} – ${to}`,
  rangeAllUntil: (date) => `All moments, up to ${date}`,
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
  // ─── 网页：时间线 ──────────────────────────────
  timelinePageTitle: (name) => `${name}'s timeline`,
  timelineEmptyTitle: 'No moments in this period yet',
  loadMore: 'Load more',
  loadingMore: 'Loading…',
  loadMoreFailed: "Couldn't load. Tap to try again",
  timelineEnd: 'No earlier moments',
  openMoment: (title) => `See everything in “${title}”`,
  openMomentUntitled: 'See everything in this moment',
  itemsTotal: (count) => plural(count, 'item', 'items'),
  audioCount: (count) => plural(count, 'recording', 'recordings'),
  closeMoment: 'Close',
  // ─── 分享回忆（App，F-136） ────────────────────
  shareMoment: 'Share this moment',
  shareMomentA11y: (title) => `Share “${title}”`,
  viewerShare: 'Share',
  selectMoments: 'Select moments to share',
  selectLink: 'Select',
  selectA11y: 'Select moments to share together',
  selectedCount: (count) => (count ? `${count} selected` : 'Tap moments to select'),
  selectCancel: 'Cancel',
  selectToggleA11y: (title) => `Select “${title}”`,
  shareSelected: (count) => `Share ${plural(count, 'moment', 'moments')}`,
  shareSelectedNone: 'Select some moments first',
  momentsFull: (max) => `You can select up to ${max} at a time`,
  momentsSheetTitle: 'Share moments',
  momentsCount: (count) => plural(count, 'moment', 'moments'),
  momentsCounts: (moments, files) =>
    files
      ? `${plural(moments, 'moment', 'moments')}, ${plural(files, 'file', 'files')}`
      : `${plural(moments, 'moment', 'moments')}, no photos or videos`,
  momentsWhat:
    "They can only see the moments you selected: text, milestones, photos, videos and recordings. Other moments, feeds, diapers, sleep and other records, health records, letters to your baby and the time of birth aren't included. If you delete one of these moments later, they won't see it anymore.",
  momentsShareMessage: (title, url) => `Moments (${title}): ${url}`,
  linkTitleMoments: (title) => `Moments · ${title}`,
  linkTitleMomentsBare: 'Moments',
  // ─── 网页：分享回忆 ────────────────────────────
  momentsPageTitle: (name) => `Moments with ${name}`,
  momentsEmptyTitle: 'These moments are no longer here',
  momentsEmptyBody: 'They may have been deleted. You could ask the person who sent you this link.',
};
