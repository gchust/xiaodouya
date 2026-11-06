type Text = string | number;

/** 主题配色（F-142）。名字要好听，一看就知道是什么颜色。 */
export const themeUi = {
  row: '主题配色',
  rowSub: (theme: Text, appearance: Text) => `${theme} · ${appearance}`,
  title: '主题配色',
  intro: '只改这台手机上的颜色，家人那边不变。选好马上生效。',
  themes: '配色',
  appearance: '浅色和深色',
  appearanceSystem: '跟随手机',
  appearanceLight: '浅色',
  appearanceDark: '深色',
  appearanceNote:
    '跟随手机时，手机换成深色或浅色后，小豆芽在你下次切回来时跟着换，正在填的内容不会被打断。',
  widgetNote: '桌面小工具和分享出去的网页保持原来的颜色，小工具跟随手机的深色模式。',
  inUse: '正在用',
  name: {
    paper: '暖纸',
    lavender: '薰衣草',
    mist: '雾蓝',
    seaSalt: '海盐',
    matcha: '抹茶',
  },
  desc: {
    paper: '米色纸张配赤陶色，原来的样子',
    lavender: '淡淡的灰紫，像傍晚的天',
    mist: '清晨的灰蓝，安静清爽',
    seaSalt: '浅浅的青绿，像海边的风',
    matcha: '温柔的苔绿，暖暖的',
  },
};
