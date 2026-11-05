import './zodConfig';
import { localeFromTag, parseShareFragment, setLocale } from '@xiaodouya/shared';
import { createSharePage } from './page';
import { createTimelinePage } from './timeline';

declare const __API_URL__: string;
declare const __API_REGION__: string;
declare const __ALLOW_LOCAL_HTTP__: boolean;

const locale = localeFromTag(navigator.language) ?? 'en';
setLocale(locale);
document.documentElement.lang = locale === 'zh' ? 'zh' : 'en';

const root = document.getElementById('root');

function start() {
  if (!root) return;
  // 片段是 `#令牌`（一天，旧版 App 发的链接也是这样）或 `#t/令牌`（时间线）。
  const link = parseShareFragment(location.hash);
  const options = {
    root,
    token: link?.token ?? null,
    api: { url: __API_URL__, region: __API_REGION__ },
    allowLocalHttp: __ALLOW_LOCAL_HTTP__,
  };
  if (link?.kind === 'timeline') void createTimelinePage(options).load();
  else void createSharePage(options).load();
}

start();
window.addEventListener('hashchange', start);
