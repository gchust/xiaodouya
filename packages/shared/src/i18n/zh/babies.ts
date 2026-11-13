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
  addSubmit: '加好了',
  added: (name: Text) => `已加上${name}，现在看的是${name}`,
  regionThisBaby: '这个宝宝的地区',
  regionHint: '决定这个宝宝的疫苗本和默认单位，只有管理员能改。',
  regionByAdmin: (name: Text) => `地区先用${name}，管理员可以在资料里改。`,
};
