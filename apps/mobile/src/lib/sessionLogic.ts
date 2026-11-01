/** 本地数据属于“哪个人在哪个家庭”。不依赖 React Native，便于测试。 */
// 删除账号走和主动退出相同的清除路径，见 app.tsx 的 clearSession。
export function sessionOwner(userId: string, familyId: string | null): string {
  return `${userId}/${familyId ?? ''}`;
}

/**
 * 只有换了人或换了家庭才清本地数据。同一个人重新登录时必须保留：
 * 里面可能有登录过期之前、还没来得及同步的记录。
 */
export function shouldClearLocalData(previousOwner: string | null, nextOwner: string): boolean {
  return previousOwner !== null && previousOwner !== nextOwner;
}

/**
 * 夜间安静由服务端判断，它只能从这里知道用户在哪个时区。没有手动设置时区的界面，
 * 所以手机的时区就是准的：新用户的默认值和出门换时区都走这一条。返回 null 表示不用改。
 */
export function timezoneToSync(current: string, device: string | null): string | null {
  return device && device !== current ? device : null;
}
