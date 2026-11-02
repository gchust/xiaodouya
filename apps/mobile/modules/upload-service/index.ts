import { type EventSubscription, requireOptionalNativeModule } from 'expo-modules-core';

export interface UploadNoticeInput {
  channelName: string;
  title: string;
  text: string | null;
  /** null 表示还不知道进度，通知显示不确定的进度条。 */
  percent: number | null;
  cancelLabel: string;
  /** 服务被系统叫停时（6 小时上限）留下的那条通知的文字。 */
  pausedTitle: string;
  detailsLink: string;
  cancelLink: string;
}

export type UploadServiceEvent = { type: 'timeout' | 'taskRemoved' };

interface NativeUploadService {
  start(notice: UploadNoticeInput): boolean;
  update(notice: UploadNoticeInput): void;
  stop(): void;
  isRunning(): boolean;
  releaseKeepAlive(): void;
  addListener(
    name: 'onServiceEvent',
    listener: (event: UploadServiceEvent) => void,
  ): EventSubscription;
}

/** iOS 上没有这个模块（`platforms` 只写了 android），调用方拿到 null 就什么都不做。 */
export const UploadServiceNative =
  requireOptionalNativeModule<NativeUploadService>('UploadService');

export const KEEP_ALIVE_TASK = 'XiaodouyaUploadKeepAlive';
