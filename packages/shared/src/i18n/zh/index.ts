import { common } from './common';
import { domain } from './domain';
import { health } from './health';

/** 中文是基准：英文目录的类型就是这个对象的类型，缺键或参数不一样都编译不过。 */
export const zh = {
  common,
  domain,
  health,
};

export type Catalog = typeof zh;
/** 插值参数：数字和文字都直接显示。 */
export type Text = string | number;
