import type { Catalog } from '../zh';

export const storageUi: Catalog['storageUi'] = {
  r2Note:
    'Recommended. No download fees, good for lots of photos and videos. When creating the bucket, choose a location close to your family.',
  s3Note: 'Choose a region close to your family. Data is stored there, but downloads cost money.',
  otherNote:
    'Works with Backblaze B2, Wasabi, Alibaba Cloud OSS, self-hosted MinIO and anything else with an S3-compatible API.',
  readFailed: "Couldn't read it",
  reread: 'Read again',
  connectFailed: 'Connection failed',
  settingsSaved: 'Storage settings saved',
  saveFailed: 'Saving failed',
  connected: 'Connected',
  usingDefault: 'Using the server default storage',
  notSet: 'Not set up yet',
  backToFamily: 'Back to Family',
  backFamilyLink: '‹ Family',
  currentStorage: 'Current storage',
  photos: (size) => `Photos ${size}`,
  videos: (size) => `Videos ${size}`,
  audio: (size) => `Recordings ${size}`,
  docs: (size) => `Documents ${size}`,
  total: (size, limit) =>
    `Total ${size}${limit} · Files upload directly from the phone, not through the server`,
  limit: (size) => ` (limit ${size})`,
  provider: 'Provider',
  otherS3: 'Other S3-compatible',
  accountIdPlaceholder: 'Found on the right of the Cloudflare dashboard',
  secretKept: 'Saved. Leave blank to keep it',
  cdn: 'Public CDN domain (optional)',
  cdnHint:
    "Leave blank and all files use short-lived signed links, the most private option. If filled in, photos and videos use this public address: faster, but the address doesn't expire (file names can't be guessed). Documents always use signed links only.",
  testing: 'Testing…',
  testConnection: 'Test connection',
  testOk: (message, ms) => `Connected · ${message} · ${ms}ms`,
  testFailed: (message) => `Connection failed: ${message}`,
  options: 'Options',
  videoWifi: 'Upload videos only on Wi-Fi',
  videoWifiSub: 'On mobile data they wait in line, and continue on Wi-Fi',
  secretNote:
    "Documents are always private, with links valid for 10 minutes when opened. Keys are saved only on the server, encrypted, and never stored on anyone's phone.",
  usedOf: (used, total) => `${used} used of ${total}`,
  usedOnly: (used) => `${used} used`,
  photosLabel: 'Photos',
  videosLabel: 'Videos',
  audioLabel: 'Recordings',
  docsLabel: 'Documents',
  trashHeld: (size, days) =>
    `Recently deleted content (${size}) stays for ${days} more days, then it's permanently removed. It doesn't count toward used space during that time, except anything over the limit after a very large deletion.`,
  trashFree: (days) =>
    `After you delete memories or documents, the space is free right away. Files stay for ${days} more days before they're permanently removed.`,
  hostedNote:
    "Photos, videos and documents are stored on Xiaodouya's servers. There's nothing for you to set up.\n",
};
