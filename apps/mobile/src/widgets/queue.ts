/**
 * 把异步任务排成一队，一个做完再做下一个；前一个失败不挡后一个。
 *
 * 小工具的每次点击都是一个独立的后台任务，几个任务会同时跑。不排队的话，一个任务读完数据、
 * 还没画完，另一个任务已经写入并设好了“刚记好”，前一个就会把新的提示配上旧的数据画出来
 * （见 PITFALLS）。写入、读数据、画都放进同一个队列，画出来的永远是一致的。
 */
export function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
}
