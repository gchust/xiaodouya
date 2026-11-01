import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkArchive, minLoadAlignment } from './check-native-libs.mjs';

function elf64(alignments) {
  const phoff = 64;
  const phentsize = 56;
  const elf = Buffer.alloc(phoff + phentsize * alignments.length);
  elf.writeUInt32BE(0x7f454c46, 0);
  elf[4] = 2;
  elf.writeBigUInt64LE(BigInt(phoff), 32);
  elf.writeUInt16LE(phentsize, 54);
  elf.writeUInt16LE(alignments.length, 56);
  alignments.forEach((alignment, i) => {
    const header = phoff + i * phentsize;
    elf.writeUInt32LE(1, header);
    elf.writeBigUInt64LE(BigInt(alignment), header + 48);
  });
  return elf;
}

function elf32() {
  const elf = Buffer.alloc(64);
  elf.writeUInt32BE(0x7f454c46, 0);
  elf[4] = 1;
  return elf;
}

/** 只写 method=0（不压缩）的最小 zip，padding 用本地头的 extra 字段补齐到指定位置。 */
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data, align } of files) {
    const nameBytes = Buffer.from(name);
    let pad = 0;
    if (align) pad = (align - ((offset + 30 + nameBytes.length) % align)) % align;
    const local = Buffer.alloc(30 + nameBytes.length + pad);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(pad, 28);
    nameBytes.copy(local, 30);
    const record = Buffer.alloc(46 + nameBytes.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    nameBytes.copy(record, 46);
    central.push(record);
    chunks.push(local, data);
    offset += local.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBytes, eocd]);
}

test('取所有 LOAD 段里最小的对齐，32 位不看', () => {
  assert.equal(minLoadAlignment(elf64([16384, 4096])), 4096);
  assert.equal(minLoadAlignment(elf32()), null);
});

test('16 KB 对齐、未压缩且 zip 位置也对齐的 APK 通过', () => {
  const apk = zip([
    { name: 'lib/arm64-v8a/liba.so', data: elf64([16384]), align: 16384 },
    { name: 'lib/armeabi-v7a/liba.so', data: elf32(), align: 4096 },
  ]);
  const result = checkArchive(apk, { isBundle: false });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.abis, ['arm64-v8a', 'armeabi-v7a']);
});

test('64 位库只按 4 KB 对齐要报错', () => {
  const apk = zip([{ name: 'lib/arm64-v8a/liba.so', data: elf64([4096]), align: 16384 }]);
  const { problems } = checkArchive(apk, { isBundle: false });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /4096/);
});

test('未压缩的库在 zip 里没对齐要报错，AAB 不看这一项', () => {
  const entry = { name: 'lib/arm64-v8a/liba.so', data: elf64([16384]) };
  assert.match(checkArchive(zip([entry]), { isBundle: false }).problems[0], /zip/);
  const aab = zip([{ ...entry, name: 'base/lib/arm64-v8a/liba.so' }]);
  assert.deepEqual(checkArchive(aab, { isBundle: true }).problems, []);
});

test('只有 32 位没有 64 位要报错', () => {
  const apk = zip([{ name: 'lib/armeabi-v7a/liba.so', data: elf32() }]);
  assert.match(checkArchive(apk, { isBundle: false }).problems[0], /arm64-v8a/);
});
