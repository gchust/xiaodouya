/** 本地数据属于“哪个人在哪个家庭”。不依赖 React Native，便于测试。 */
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
