import { describe, expect, it } from 'vitest';
import {
  clampPan,
  containedSize,
  cropRect,
  gridItemWidth,
  keyboardLift,
  sheetMaxHeight,
} from '../src/lib/layout';

describe('查看大图', () => {
  it('横图在竖屏里按宽度放', () => {
    expect(containedSize(400, 800, 2000, 1000)).toEqual({ width: 400, height: 200 });
  });
  it('竖图按高度放', () => {
    expect(containedSize(400, 800, 1000, 4000)).toEqual({ width: 200, height: 800 });
  });
  it('不知道原图尺寸时按容器算', () => {
    expect(containedSize(400, 800)).toEqual({ width: 400, height: 800 });
    expect(containedSize(400, 800, 0, 100)).toEqual({ width: 400, height: 800 });
  });
  it('放大两倍时，边缘刚好能拖到容器边缘', () => {
    expect(clampPan(1000, 2, 400, 400)).toBe(200);
    expect(clampPan(-1000, 2, 400, 400)).toBe(-200);
    expect(clampPan(50, 2, 400, 400)).toBe(50);
  });
  it('放大后还没超出容器的方向不能拖', () => {
    expect(clampPan(100, 2, 800, 200)).toBe(0);
  });
  it('没有放大时不能拖', () => {
    expect(clampPan(100, 1, 400, 400)).toBe(0);
  });
});

describe('裁剪头像', () => {
  const frame = 300;
  it('没有放大也没有拖动时，取短边居中的正方形', () => {
    expect(cropRect({ frame, imageWidth: 2000, imageHeight: 1000, zoom: 1, x: 0, y: 0 })).toEqual({
      originX: 500,
      originY: 0,
      width: 1000,
      height: 1000,
    });
    expect(cropRect({ frame, imageWidth: 160, imageHeight: 320, zoom: 1, x: 0, y: 0 })).toEqual({
      originX: 0,
      originY: 80,
      width: 160,
      height: 160,
    });
  });
  it('放大两倍后框里只剩一半宽度', () => {
    expect(cropRect({ frame, imageWidth: 1000, imageHeight: 1000, zoom: 2, x: 0, y: 0 })).toEqual({
      originX: 250,
      originY: 250,
      width: 500,
      height: 500,
    });
  });
  it('图片往右拖时，框里看到的是图片左边的部分', () => {
    // 2000×1000 放进 300 的框，每个图片像素显示 0.3dp，最多能往右拖 150dp。
    expect(cropRect({ frame, imageWidth: 2000, imageHeight: 1000, zoom: 1, x: 150, y: 0 })).toEqual(
      { originX: 0, originY: 0, width: 1000, height: 1000 },
    );
    expect(
      cropRect({ frame, imageWidth: 2000, imageHeight: 1000, zoom: 1, x: -150, y: 0 }),
    ).toEqual({ originX: 1000, originY: 0, width: 1000, height: 1000 });
  });
  it('放大后图片往下拖时，框里看到的是图片上面的部分', () => {
    expect(cropRect({ frame, imageWidth: 1000, imageHeight: 1000, zoom: 2, x: 0, y: 150 })).toEqual(
      { originX: 250, originY: 0, width: 500, height: 500 },
    );
  });
  it('结果永远落在图片里面，否则原生裁剪会报错', () => {
    for (const zoom of [1, 1.37, 2.5, 3.3, 5]) {
      for (const x of [-9999, -33.3, 0, 77.7, 9999]) {
        const rect = cropRect({ frame: 327.3, imageWidth: 4031, imageHeight: 3023, zoom, x, y: x });
        expect(rect.originX).toBeGreaterThanOrEqual(0);
        expect(rect.originY).toBeGreaterThanOrEqual(0);
        expect(rect.originX + rect.width).toBeLessThanOrEqual(4031);
        expect(rect.originY + rect.height).toBeLessThanOrEqual(3023);
        expect(rect.width).toBe(rect.height);
        expect(Number.isInteger(rect.originX + rect.originY + rect.width)).toBe(true);
      }
    }
  });
  it('很小的图放到最大也至少留一个像素', () => {
    const rect = cropRect({ frame, imageWidth: 2, imageHeight: 2, zoom: 5, x: 0, y: 0 });
    expect(rect.width).toBe(1);
  });
});

describe('弹层和键盘', () => {
  it('窗口没有缩小时（edge-to-edge），抬高整个键盘高度', () => {
    expect(keyboardLift(300, 800, 800)).toBe(300);
  });
  it('窗口已经缩小时（adjustResize），不重复抬高', () => {
    expect(keyboardLift(300, 800, 500)).toBe(0);
  });
  it('窗口只缩小了一部分时，只补差额', () => {
    expect(keyboardLift(300, 800, 700)).toBe(200);
  });
  it('键盘收起后不抬高，窗口还没恢复也一样', () => {
    expect(keyboardLift(0, 800, 800)).toBe(0);
    expect(keyboardLift(0, 800, 500)).toBe(0);
  });
  it('键盘收起时最大高度是 88%', () => {
    expect(sheetMaxHeight(800, 0, 24)).toBeCloseTo(704);
  });
  it('键盘打开时扣掉键盘和状态栏，「取消」留在屏幕内', () => {
    expect(sheetMaxHeight(800, 300, 24)).toBe(476);
    expect(sheetMaxHeight(500, 0, 24)).toBe(440);
  });
  it('高度不够时不返回负数', () => {
    expect(sheetMaxHeight(100, 300, 24)).toBe(0);
  });
});

describe('网格宽度', () => {
  it('360dp 屏上每行的总宽不超过容器', () => {
    const container = 360 - 44;
    expect(3 * gridItemWidth(container, 3, 10) + 2 * 10).toBeLessThanOrEqual(container);
    expect(2 * gridItemWidth(container, 2, 8) + 8).toBeLessThanOrEqual(container);
  });
  it('常见屏宽下都排得下，最多只差 0.05dp', () => {
    for (let width = 280; width <= 900; width += 1) {
      for (const [columns, gap] of [
        [2, 8],
        [3, 4],
        [3, 10],
      ] as const) {
        const total = columns * gridItemWidth(width, columns, gap) + (columns - 1) * gap;
        expect(total).toBeLessThanOrEqual(width);
        expect(width - total).toBeLessThan(0.05);
      }
    }
  });
  it('容器比 gap 还窄时不返回负数', () => {
    expect(gridItemWidth(4, 3, 10)).toBe(0);
  });
});
