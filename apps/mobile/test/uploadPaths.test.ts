import { describe, expect, it } from 'vitest';
import { resolveUploadPath, toStoredUploadPath } from '../src/data/uploadPaths';

const BEFORE_UPDATE = 'file:///var/mobile/Containers/Data/Application/AAAA-1111/Documents/';
const AFTER_UPDATE = 'file:///var/mobile/Containers/Data/Application/BBBB-2222/Documents/';
const ANDROID = 'file:///data/user/0/com.gchust.xiaodouya/files/';

describe('上传队列的文件路径', () => {
  it('存的是相对路径', () => {
    expect(toStoredUploadPath(`${BEFORE_UPDATE}uploads/id-original`, BEFORE_UPDATE)).toBe(
      'uploads/id-original',
    );
  });

  it('iOS 更新后容器路径变了，新写的行仍然指向现在的文件', () => {
    const stored = toStoredUploadPath(`${BEFORE_UPDATE}uploads/id-thumb`, BEFORE_UPDATE);
    expect(resolveUploadPath(stored, AFTER_UPDATE)).toBe(`${AFTER_UPDATE}uploads/id-thumb`);
  });

  it('旧版本写的绝对路径能读，Android 上结果不变', () => {
    const old = `${ANDROID}uploads/id-original`;
    expect(resolveUploadPath(old, ANDROID)).toBe(old);
  });

  it('旧版本写的绝对路径，容器变了也能找到文件', () => {
    expect(resolveUploadPath(`${BEFORE_UPDATE}uploads/id-original`, AFTER_UPDATE)).toBe(
      `${AFTER_UPDATE}uploads/id-original`,
    );
  });

  it('目录地址结尾有没有斜杠都一样', () => {
    const root = AFTER_UPDATE.slice(0, -1);
    expect(toStoredUploadPath(`${AFTER_UPDATE}uploads/a`, root)).toBe('uploads/a');
    expect(resolveUploadPath('uploads/a', root)).toBe(`${AFTER_UPDATE}uploads/a`);
  });

  it('不在文档目录下的路径不改动，不能拼出一个错误的地址', () => {
    const elsewhere = 'file:///tmp/picked.jpg';
    expect(toStoredUploadPath(elsewhere, AFTER_UPDATE)).toBe(elsewhere);
    expect(resolveUploadPath(elsewhere, AFTER_UPDATE)).toBe(elsewhere);
  });
});
