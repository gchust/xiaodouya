type Text = string | number;

/** 全部记录和回忆的搜索（issue #109）。 */
export const search = {
  recordsPlaceholder: '搜药名、体温、备注、谁记的',
  recordsA11y: '搜索记录',
  recallPlaceholder: '搜回忆和信的标题、正文',
  recallA11y: '搜索回忆和信',
  clear: '清空搜索',
  count: (n: number) => `找到 ${n} 条`,
  empty: (query: Text) => `没有找到“${query}”`,
  emptySub: '换个说法试试。',
  emptyFilterSub: '换个说法试试，或者把上面的类型换成“全部”。',
  recallLink: '搜索',
  recallTitle: '搜索回忆',
  backToRecall: '返回回忆',
  backRecallLink: '‹ 回忆',
  recallHint: '回忆和写给宝宝的信都在这里搜，标题和正文里的字都算。',
  momentTag: '回忆',
  letterTag: '信',
  openA11y: (kind: Text, title: Text) => `${kind}：${title}`,
};
