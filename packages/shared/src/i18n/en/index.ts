import type { Catalog } from '../zh';
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

export const en: Catalog = {
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
