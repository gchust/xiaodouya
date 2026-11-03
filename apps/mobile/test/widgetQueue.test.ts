import { describe, expect, it } from 'vitest';
import { createQueue } from '../src/widgets/queue';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('小工具的任务队列', () => {
  it('后来的任务等前一个做完才开始，不会读到一半的数据', async () => {
    const queue = createQueue();
    const log: string[] = [];
    let release!: () => void;
    const first = queue(async () => {
      log.push('写入开始');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      log.push('写入完成');
    });
    const second = queue(async () => {
      log.push('重画');
    });
    await tick();
    expect(log).toEqual(['写入开始']);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(['写入开始', '写入完成', '重画']);
  });

  it('前一个失败不挡后一个，失败也照样交给调用方', async () => {
    const queue = createQueue();
    const failed = queue(async () => {
      throw new Error('写坏了');
    });
    const next = queue(async () => 'ok');
    await expect(failed).rejects.toThrow('写坏了');
    await expect(next).resolves.toBe('ok');
  });
});
