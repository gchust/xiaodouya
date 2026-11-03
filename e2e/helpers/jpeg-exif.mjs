// 手写 EXIF：给 JPEG 塞一段明显虚构的 GPS，再查文件里还有没有。
// 流程 03a 的样例（e2eFixtures 的 EXIF_JPEG_BASE64）和手动走查的大样例都从这里来，不放真实照片。
//
//   node e2e/helpers/jpeg-exif.mjs add <输入.jpg> <输出.jpg>   写入 GPS 和 Orientation=6
//   node e2e/helpers/jpeg-exif.mjs show <文件.jpg>             打印 jpegMetadata 的结果

import { readFileSync, writeFileSync } from 'node:fs';

export const FICTIONAL_DESCRIPTION = 'XIAODOUYA FICTIONAL TEST IMAGE';

const GPS_INFO_TAG = 0x8825;
const ORIENTATION_TAG = 0x0112;

/** 北纬 12°34'56"，东经 123°45'6"：数字一眼看得出是编的。 */
const LATITUDE = [12, 34, 56];
const LONGITUDE = [123, 45, 6];

function ifd(entries, nextOffset, valueStart) {
  const table = Buffer.alloc(2 + entries.length * 12 + 4);
  const extra = [];
  let extraAt = valueStart + table.length;
  table.writeUInt16LE(entries.length, 0);
  entries.forEach(({ tag, type, count, inline, data }, i) => {
    const at = 2 + i * 12;
    table.writeUInt16LE(tag, at);
    table.writeUInt16LE(type, at + 2);
    table.writeUInt32LE(count, at + 4);
    if (data) {
      table.writeUInt32LE(extraAt, at + 8);
      extra.push(data);
      extraAt += data.length;
    } else {
      inline.copy(table, at + 8);
    }
  });
  table.writeUInt32LE(nextOffset, 2 + entries.length * 12);
  return Buffer.concat([table, ...extra]);
}

const shortValue = (value) => {
  const out = Buffer.alloc(4);
  out.writeUInt16LE(value, 0);
  return out;
};
const longValue = (value) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
};
const asciiValue = (text) => {
  const out = Buffer.alloc(4);
  out.write(text, 'ascii');
  return out;
};
const rationals = (values) => {
  const out = Buffer.alloc(values.length * 8);
  values.forEach((value, i) => {
    out.writeUInt32LE(value, i * 8);
    out.writeUInt32LE(1, i * 8 + 4);
  });
  return out;
};

function exifSegment() {
  const description = Buffer.from(`${FICTIONAL_DESCRIPTION}\0`, 'ascii');
  const zerothEntries = (gpsOffset) => [
    { tag: 0x010e, type: 2, count: description.length, data: description },
    { tag: ORIENTATION_TAG, type: 3, count: 1, inline: shortValue(6) },
    { tag: GPS_INFO_TAG, type: 4, count: 1, inline: longValue(gpsOffset) },
  ];
  const zerothLength = ifd(zerothEntries(0), 0, 8).length;
  const gpsOffset = 8 + zerothLength;
  const zeroth = ifd(zerothEntries(gpsOffset), 0, 8);
  const gps = ifd(
    [
      { tag: 1, type: 2, count: 2, inline: asciiValue('N') },
      { tag: 2, type: 5, count: 3, data: rationals(LATITUDE) },
      { tag: 3, type: 2, count: 2, inline: asciiValue('E') },
      { tag: 4, type: 5, count: 3, data: rationals(LONGITUDE) },
    ],
    0,
    gpsOffset,
  );
  const header = Buffer.from('II*\0\x08\0\0\0', 'latin1');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), header, zeroth, gps]);
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([segment, payload]);
}

/** 紧跟在 SOI 后面写入。不解码，图像数据一个字节也不动。 */
export function withFictionalExif(jpeg) {
  const bytes = Buffer.from(jpeg);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('不是 JPEG');
  return Buffer.concat([bytes.subarray(0, 2), exifSegment(), bytes.subarray(2)]);
}

/** 走一遍文件头：有没有 EXIF 段、里面有没有 GPS。到 SOS 为止，后面是图像数据。 */
export function jpegMetadata(input) {
  const bytes = Buffer.from(input);
  const result = {
    isJpeg: bytes[0] === 0xff && bytes[1] === 0xd8,
    width: 0,
    height: 0,
    exif: false,
    gps: false,
    orientation: null,
    xmp: false,
    /**
     * 可能带元数据的 APP 段。APP0（JFIF）不算；ICC 色彩配置也不算：Android 编码 JPEG 时自己会写一段，
     * 里面只有色彩信息。
     */
    appSegments: 0,
  };
  if (!result.isJpeg) return result;
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(i + 2);
    const body = bytes.subarray(i + 4, i + 2 + length);
    const isIcc = marker === 0xe2 && body.subarray(0, 11).toString('latin1') === 'ICC_PROFILE';
    if (marker > 0xe0 && marker <= 0xef && !isIcc) result.appSegments += 1;
    if (marker === 0xe1 && body.subarray(0, 6).toString('latin1') === 'Exif\0\0') {
      result.exif = true;
      const tiff = body.subarray(6);
      const little = tiff.subarray(0, 2).toString('latin1') === 'II';
      const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
      const u32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
      const start = u32(4);
      const count = u16(start);
      for (let entry = 0; entry < count; entry++) {
        const at = start + 2 + entry * 12;
        if (u16(at) === GPS_INFO_TAG) result.gps = true;
        if (u16(at) === ORIENTATION_TAG) result.orientation = u16(at + 8);
      }
    }
    if (marker === 0xe1 && body.subarray(0, 4).toString('latin1') === 'http') result.xmp = true;
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      result.height = bytes.readUInt16BE(i + 5);
      result.width = bytes.readUInt16BE(i + 7);
    }
    i += 2 + length;
  }
  return result;
}

if (process.argv[1] === import.meta.filename) {
  const [command, input, output] = process.argv.slice(2);
  if (command === 'add') {
    writeFileSync(output, withFictionalExif(readFileSync(input)));
  } else if (command === 'show') {
    console.log(jpegMetadata(readFileSync(input)));
  } else {
    console.error('用法见文件开头');
    process.exit(1);
  }
}
