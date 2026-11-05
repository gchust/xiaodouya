import { parseShareFragment } from '@xiaodouya/shared';
import type { ApiTarget } from './api';
import { createSharePage } from './page';
import { createTimelinePage } from './timeline';

export interface RouteOptions {
  root: HTMLElement;
  api: ApiTarget;
  allowLocalHttp: boolean;
  fetcher?: typeof fetch;
}

/**
 * 按片段打开对应的页面：`#令牌` 是一天（旧版 App 发的链接也是这样），`#t/令牌` 是时间线，
 * `#m/令牌` 是选中的几段回忆（F-136，和时间线同一个页面、同样的接口）。认不出的片段交给一天的页面，
 * 它没有令牌时直接说链接失效，不发请求。
 */
export function openShareLink(
  hash: string,
  { root, api, allowLocalHttp, fetcher }: RouteOptions,
): Promise<void> {
  const link = parseShareFragment(hash);
  const options = {
    root,
    token: link?.token ?? null,
    api,
    allowLocalHttp,
    ...(fetcher ? { fetcher } : {}),
  };
  if (link?.kind === 'timeline' || link?.kind === 'moments') {
    return createTimelinePage(options).load();
  }
  return createSharePage(options).load();
}
