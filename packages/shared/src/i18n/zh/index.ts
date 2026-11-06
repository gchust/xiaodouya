import { account } from './account';
import { auth } from './auth';
import { common } from './common';
import { confirm } from './confirm';
import { domain } from './domain';
import { family } from './family';
import { feedback } from './feedback';
import { health } from './health';
import { info } from './info';
import { library } from './library';
import { money } from './money';
import { nutritionUi } from './nutritionUi';
import { recall } from './recall';
import { records } from './records';
import { share } from './share';
import { storageUi } from './storageUi';
import { today } from './today';
import { ui } from './ui';
import { update } from './update';
import { widgetUi } from './widgetUi';

/** 中文是基准：英文目录的类型就是这个对象的类型，缺键或参数不一样都编译不过。 */
export const zh = {
  common,
  confirm,
  widgetUi,
  storageUi,
  family,
  feedback,
  info,
  recall,
  auth,
  nutritionUi,
  money,
  library,
  records,
  share,
  today,
  account,
  ui,
  update,
  domain,
  health,
};

export type Catalog = typeof zh;
/** 插值参数：数字和文字都直接显示。 */
export type Text = string | number;
