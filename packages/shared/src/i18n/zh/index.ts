import { account } from './account';
import { auth } from './auth';
import { common } from './common';
import { domain } from './domain';
import { family } from './family';
import { health } from './health';
import { info } from './info';
import { nutritionUi } from './nutritionUi';
import { recall } from './recall';
import { records } from './records';
import { storageUi } from './storageUi';
import { today } from './today';
import { ui } from './ui';
import { widgetUi } from './widgetUi';

/** 中文是基准：英文目录的类型就是这个对象的类型，缺键或参数不一样都编译不过。 */
export const zh = {
  common,
  widgetUi,
  storageUi,
  family,
  info,
  recall,
  auth,
  nutritionUi,
  records,
  today,
  account,
  ui,
  domain,
  health,
};

export type Catalog = typeof zh;
/** 插值参数：数字和文字都直接显示。 */
export type Text = string | number;
