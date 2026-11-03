import type { Catalog } from '../zh';

export const update: Catalog['update'] = {
  row: 'Check for updates',
  rowCurrent: (version) => `Current version ${version}`,
  rowAvailable: (version) => `New version ${version}`,
  rowChecking: 'Checking…',
  title: 'Update Xiaodouya',
  newVersion: 'New version',
  currentAndSize: (current, size) => `You have ${current} · about ${size} to download`,
  notesTitle: "What's new",
  required: 'This version is no longer supported. Please update soon.',
  keepsData:
    "Updating won't touch the records and photos on this phone. Once it's downloaded, your phone will ask you to confirm the install.",
  update: 'Update',
  later: 'Later',
  checking: 'Checking for a new version…',
  upToDate: (version) => `You're on the latest version ${version}`,
  downloading: 'Downloading',
  downloaded: (done, total) => `${done} / ${total}`,
  cancelDownload: 'Cancel download',
  verifying: 'Checking the downloaded file…',
  readyTitle: 'Ready to install',
  install: 'Install',
  installHint: 'After tapping Install, tap Install once more in the window your phone shows.',
  needPermission:
    'Xiaodouya needs permission to install apps. Turn on "Allow from this source" in Settings, then come back and tap Install.',
  openSettings: 'Open Settings',
  failedCheck: "Couldn't check for a new version right now. Please try again later.",
  failedNetwork: "The download didn't finish. Check your connection and try again.",
  failedChecksum:
    "The downloaded file didn't match the release, so it was deleted. Please try again.",
  failedInstall: "Couldn't open the install screen. Please try again.",
  retry: 'Try again',
  toast: (version) => `A new version of Xiaodouya is available: ${version}`,
  toastRequired: (version) => `This version is no longer supported. Please update to ${version}`,
  toastAction: 'View',
};
