#!/usr/bin/env node
// 用法：node scripts/check-native-libs.mjs <apk 或 aab>...
// 检查 Google Play 对原生库的要求，不依赖 Android SDK：
//   1. 有 32 位 ABI 就必须有对应的 64 位 ABI。
//   2. 64 位的 .so，每个 LOAD 段都要按 16 KB 对齐。
//   3. APK 里不压缩的 .so，在 zip 里也要按 16 KB 对齐，否则 16 KB 设备无法直接映射。
// https://developer.android.com/google/play/requirements/64-bit
// https://developer.android.com/guide/practices/page-sizes
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const PAGE_16K = 16 * 1024;
const PT_LOAD = 1;

export function listZipEntries(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip 文件');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (at === 0xffffffff) throw new Error('不支持 zip64');
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localHeader = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    // 数据位置要看本地头：它的 extra 字段可以和中央目录不同，zipalign 正是靠它补齐的。
    const dataOffset =
      localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
    entries.push({ name, method, compressedSize, dataOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readEntry(zip, entry) {
  const raw = zip.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  return entry.method === 0 ? raw : inflateRawSync(raw);
}

/** 返回 ELF 里最小的 LOAD 段对齐值；不是 64 位 ELF 时返回 null。 */
export function minLoadAlignment(elf) {
  if (elf.length < 64 || elf.readUInt32BE(0) !== 0x7f454c46) throw new Error('不是 ELF 文件');
  if (elf[4] !== 2) return null;
  const phoff = Number(elf.readBigUInt64LE(32));
  const phentsize = elf.readUInt16LE(54);
  const phnum = elf.readUInt16LE(56);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < phnum; i += 1) {
    const header = phoff + i * phentsize;
    if (elf.readUInt32LE(header) === PT_LOAD) {
      min = Math.min(min, Number(elf.readBigUInt64LE(header + 48)));
    }
  }
  return min;
}

/** 返回 { abis, libs, problems }。AAB 的库在 base/lib/ 下，APK 在 lib/ 下。 */
export function checkArchive(zip, { isBundle }) {
  const prefix = isBundle ? 'base/lib/' : 'lib/';
  const libs = listZipEntries(zip).filter(
    (entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.so'),
  );
  const problems = [];
  const abis = new Set();
  const report = [];
  for (const entry of libs) {
    const [abi, ...rest] = entry.name.slice(prefix.length).split('/');
    abis.add(abi);
    const alignment = minLoadAlignment(readEntry(zip, entry));
    const stored = entry.method === 0;
    report.push({ abi, name: rest.join('/'), alignment, stored });
    if (alignment === null) continue;
    if (alignment < PAGE_16K) {
      problems.push(`${entry.name}：LOAD 段按 ${alignment} 字节对齐，要求至少 ${PAGE_16K}`);
    }
    if (!isBundle && stored && entry.dataOffset % PAGE_16K !== 0) {
      problems.push(
        `${entry.name}：未压缩，但在 zip 里的位置 ${entry.dataOffset} 没有按 16 KB 对齐`,
      );
    }
  }
  const pairs = [
    ['armeabi-v7a', 'arm64-v8a'],
    ['x86', 'x86_64'],
  ];
  for (const [bit32, bit64] of pairs) {
    if (abis.has(bit32) && !abis.has(bit64)) problems.push(`有 ${bit32}，缺少 64 位的 ${bit64}`);
  }
  return { abis: [...abis].sort(), libs: report, problems };
}

function main(files) {
  if (files.length === 0) {
    console.error('用法：check-native-libs.mjs <apk 或 aab>...');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const { abis, libs, problems } = checkArchive(readFileSync(file), {
      isBundle: file.endsWith('.aab'),
    });
    const bit64 = libs.filter((lib) => lib.alignment !== null);
    console.log(
      `${basename(file)}：ABI ${abis.join('、')}，共 ${libs.length} 个原生库，其中 64 位 ${bit64.length} 个`,
    );
    const smallest = Math.min(...bit64.map((lib) => lib.alignment));
    if (bit64.length > 0) console.log(`  64 位库最小的 LOAD 对齐：${smallest} 字节`);
    for (const problem of problems) console.error(`  不符合：${problem}`);
    if (problems.length > 0) failed = true;
    else console.log('  符合 64 位和 16 KB 要求');
  }
  if (failed) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
