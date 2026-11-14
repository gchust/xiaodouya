type Text = string | number;

/** 多个宝宝（issue #106）：切换、加宝宝。 */
export const babies = {
  switchTitle: '选宝宝',
  switchA11y: (name: Text) => `现在看的是${name}，点开换一个宝宝`,
  pickA11y: (name: Text) => `看${name}的记录`,
  current: '正在看',
  switchNote: '记录、疫苗本、小金库、证件都按宝宝分开，奶粉、育儿资料和收藏全家共用。',
  switched: (name: Text) => `现在看的是${name}`,
  viewAvatar: (name: Text) => `看${name}的头像`,
  addAvatar: (name: Text) => `给${name}加头像`,
  addLink: '＋ 加宝宝',
  addA11y: '再加一个宝宝',
  addTitle: '再加一个宝宝',
  addIntro: '只填名字和出生时间就够了，其他的以后在资料里补。',
  addWarning: '加好后暂时不能删除。家里其他人要把小豆芽更新到最新版，才能继续同步。',
  addSubmit: '加好了',
  added: (name: Text) => `已加上${name}，现在看的是${name}`,
  regionThisBaby: '这个宝宝的地区',
  shareFor: (name: Text) => `宝宝：${name}`,
  feedReminderBody: (name: Text) => `${name}已到平时的喂奶间隔。`,
  widgetFor: '小工具记给谁',
  widgetFollow: '跟着 App 里选的宝宝',
  widgetHint: '只在这台手机上。跟着 App 时，在今天页换了宝宝，小工具也跟着换。',
  widgetNameHint: '有几个宝宝时小工具上写宝宝的名字，不用上面的称呼。',
  regionHint: '决定这个宝宝的疫苗本和默认单位，只有管理员能改。',
  regionByAdmin: (name: Text) => `地区先用${name}，管理员可以在资料里改。`,
};
