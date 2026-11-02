import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { UploadServiceNative } from '../../modules/upload-service';
import { UploadQueue, type UploadQueueDb } from '../data/uploadQueue';
import { UploadServiceController } from '../data/uploadServiceController';
import type { Api } from './api';
import { createUploadTransport } from './media';
import { uploadServiceNotice } from './uploadStatus';

interface UploadRuntime {
  queue: UploadQueue;
  controller: UploadServiceController | null;
}

let runtime: UploadRuntime | null = null;

/**
 * 整个 JS 运行环境只有一个队列。从最近任务划掉后界面卸载了，JS 还在跑，再打开时界面重新挂载：
 * 如果各建一个队列，两个队列会同时传同一批任务。网络和前后台的监听也放在这里，不跟着界面走。
 * iOS 上没有原生模块，只有队列，上传还是只在 App 运行时进行。
 */
export function getUploadRuntime(db: UploadQueueDb, api: Api): UploadRuntime {
  if (runtime) return runtime;
  const queue = new UploadQueue(db, createUploadTransport(api));
  const native = UploadServiceNative;
  const controller = native
    ? new UploadServiceController(queue, native, uploadServiceNotice)
    : null;
  runtime = { queue, controller };
  NetInfo.addEventListener((state) => {
    const online = state.isConnected !== false;
    queue.setNetwork(!online ? 'none' : state.type === 'wifi' ? 'wifi' : 'cellular');
  });
  if (controller && native) {
    controller.attach();
    native.addListener('onServiceEvent', (event) => {
      if (event.type === 'timeout') controller.onSystemTimeout();
    });
    AppState.addEventListener('change', (state) => {
      if (state === 'active') controller.onForeground();
    });
  }
  return runtime;
}
