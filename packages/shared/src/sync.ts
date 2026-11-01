/** 后写胜出：时间相同时用 id 打破平局，保证所有设备得到同一结果。 */
export function isNewerVersion(
  incoming: { updatedAt: number; tiebreak: string },
  existing: { updatedAt: number; tiebreak: string },
): boolean {
  if (incoming.updatedAt !== existing.updatedAt) return incoming.updatedAt > existing.updatedAt;
  return incoming.tiebreak > existing.tiebreak;
}

/** 单个家庭同步一次最多返回的记录数。 */
export const SYNC_PAGE_SIZE = 500;
