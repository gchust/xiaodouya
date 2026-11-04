import { describe, expect, it } from 'vitest';
import { createTapGuard, guardTap, TAP_STUCK_MS } from '../src/domain/tapGuard';

describe('createTapGuard', () => {
  it('正在写的时候，同一个按钮再点不算', () => {
    const guard = createTapGuard({ holdMs: 1_000 });
    expect(guard.begin('feed', 0)).not.toBeNull();
    expect(guard.begin('feed', 50)).toBeNull();
    expect(guard.begin('feed', 400)).toBeNull();
    expect(guard.status('feed', 400)).toBe('pending');
  });

  it('不同的按钮各算各的', () => {
    const guard = createTapGuard({ holdMs: 1_000 });
    expect(guard.begin('wee', 0)).not.toBeNull();
    expect(guard.begin('poo', 10)).not.toBeNull();
  });

  it('写好之后的保持时间内再点不算，过了就是新的一次', () => {
    const guard = createTapGuard({ holdMs: 1_000 });
    const tap = guard.begin('sleep', 0);
    guard.succeed('sleep', tap, 80);
    expect(guard.status('sleep', 500)).toBe('done');
    expect(guard.begin('sleep', 1_079)).toBeNull();
    expect(guard.begin('sleep', 1_080)).not.toBeNull();
    expect(guard.status('sleep', 1_080)).toBe('pending');
  });

  it('写失败了马上放开，下一次点击要能记上', () => {
    const guard = createTapGuard({ holdMs: 5_000 });
    const tap = guard.begin('feed', 0);
    guard.fail('feed', tap);
    expect(guard.status('feed', 1)).toBe('idle');
    expect(guard.begin('feed', 1)).not.toBeNull();
  });

  it('一直没有结果也会放开，按钮不能永远点不了', () => {
    const guard = createTapGuard({ holdMs: 1_000 });
    guard.begin('feed', 0);
    expect(guard.begin('feed', TAP_STUCK_MS - 1)).toBeNull();
    expect(guard.status('feed', TAP_STUCK_MS)).toBe('idle');
    expect(guard.begin('feed', TAP_STUCK_MS)).not.toBeNull();
  });

  it('保持时间是 0 时，写好后立刻可以再点', () => {
    const guard = createTapGuard({ holdMs: 0 });
    const tap = guard.begin('save', 0);
    guard.succeed('save', tap, 10);
    expect(guard.begin('save', 10)).not.toBeNull();
  });

  it('卡住被放开后，上一次迟到的结果不能改掉新一次的状态', () => {
    const guard = createTapGuard({ holdMs: 1_000, stuckMs: 100 });
    const stuck = guard.begin('feed', 0);
    const retry = guard.begin('feed', 200);
    expect(retry).not.toBeNull();
    // 卡住的那次后来失败了：不能把正在写的新一次放开，否则第三下又会写一条。
    guard.fail('feed', stuck);
    expect(guard.status('feed', 210)).toBe('pending');
    guard.succeed('feed', stuck, 220);
    expect(guard.status('feed', 230)).toBe('pending');
    guard.succeed('feed', retry, 240);
    expect(guard.status('feed', 250)).toBe('done');
  });
});

describe('guardTap', () => {
  it('连点只跑一次', async () => {
    const guard = createTapGuard({ holdMs: 1_000 });
    let clock = 0;
    let runs = 0;
    let release: () => void = () => {};
    const task = () =>
      new Promise<string>((resolve) => {
        runs += 1;
        release = () => resolve('ok');
      });
    const first = guardTap(guard, 'feed', () => clock, task);
    clock = 30;
    const second = guardTap(guard, 'feed', () => clock, task);
    clock = 60;
    release();
    expect(await first).toEqual({ ran: true, value: 'ok' });
    expect(await second).toEqual({ ran: false });
    clock = 500;
    expect(await guardTap(guard, 'feed', () => clock, task)).toEqual({ ran: false });
    expect(runs).toBe(1);
  });

  it('第一次失败时错误照样抛出，第二次点击能记上', async () => {
    const guard = createTapGuard({ holdMs: 1_000 });
    const failing = () => Promise.reject(new Error('disk full'));
    await expect(guardTap(guard, 'feed', () => 0, failing)).rejects.toThrow('disk full');
    expect(
      await guardTap(
        guard,
        'feed',
        () => 10,
        async () => 'saved',
      ),
    ).toEqual({
      ran: true,
      value: 'saved',
    });
  });

  it('同步抛出的错误也会放开', async () => {
    const guard = createTapGuard({ holdMs: 1_000 });
    const throwing = (): Promise<string> => {
      throw new Error('boom');
    };
    await expect(guardTap(guard, 'feed', () => 0, throwing)).rejects.toThrow('boom');
    expect(guard.status('feed', 1)).toBe('idle');
  });
});
