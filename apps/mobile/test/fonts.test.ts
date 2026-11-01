import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FONTS_DIR = join(import.meta.dirname, '../assets/fonts');

/** 读 TrueType name 表里的 PostScript 名字（nameID 6）。 */
function postScriptName(path: string): string {
  const font = readFileSync(path);
  const tables = font.readUInt16BE(4);
  for (let i = 0; i < tables; i += 1) {
    const record = 12 + i * 16;
    if (font.toString('latin1', record, record + 4) !== 'name') continue;
    const name = font.readUInt32BE(record + 8);
    const count = font.readUInt16BE(name + 2);
    const strings = name + font.readUInt16BE(name + 4);
    for (let j = 0; j < count; j += 1) {
      const entry = name + 6 + j * 12;
      if (font.readUInt16BE(entry + 6) !== 6) continue;
      const platform = font.readUInt16BE(entry);
      const length = font.readUInt16BE(entry + 8);
      const start = strings + font.readUInt16BE(entry + 10);
      const bytes = font.subarray(start, start + length);
      return platform === 1 ? bytes.toString('latin1') : bytes.swap16().toString('utf16le');
    }
  }
  throw new Error(`${path} 没有 PostScript 名字`);
}

describe('字体文件', () => {
  it('PostScript 名字互不相同，否则 iOS 上同名的字重显示成同一个', () => {
    const names = readdirSync(FONTS_DIR)
      .filter((file) => file.endsWith('.ttf'))
      .map((file) => postScriptName(join(FONTS_DIR, file)));
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });
});
