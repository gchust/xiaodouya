import './zodConfig';
import { localeFromTag, setLocale } from '@xiaodouya/shared';
import { readToken } from './media';
import { createSharePage } from './page';

declare const __API_URL__: string;
declare const __API_REGION__: string;
declare const __ALLOW_LOCAL_HTTP__: boolean;

const locale = localeFromTag(navigator.language) ?? 'en';
setLocale(locale);
document.documentElement.lang = locale === 'zh' ? 'zh' : 'en';

const root = document.getElementById('root');

function start() {
  if (!root) return;
  void createSharePage({
    root,
    token: readToken(location.hash),
    api: { url: __API_URL__, region: __API_REGION__ },
    allowLocalHttp: __ALLOW_LOCAL_HTTP__,
  }).load();
}

start();
window.addEventListener('hashchange', start);
