import { MULTIPART_THRESHOLD_BYTES } from '@xiaodouya/shared';
import { File, FileMode, Paths } from 'expo-file-system';
import type { PickedFile } from './media';

/**
 * E2E 构建用这些内置样例代替系统选择器。系统相册的界面随 Android 版本变化，
 * 在 CI 上点它很不稳定；选择器之后的复制、缩略图、直传、完成校验走的都是真实代码。
 * 样例是一张 64×64 的渐变图，由 ImageMagick 生成。
 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAsElEQVRo3u3YwQnEQAwDwF24/lJLOkxpV4QfYoy2Ag+WRcj93ufI73fvTc8wAxwdcI8OsOffEKECwgA/Qn4L4QB8ASs2gAP4DfAt1AjlAekRhoBGKA5oC4UBfoR0AH4CC454QYRwAL8BHuBHKD3BFOBvoIAwoBGKA/RvIXz+DRHSAX4L4UfQCKWf/2+0EUoD2kJpgB8hHYCfwIIN8C3UIy5gCFgQofQIU0BbKAzQj/gPXRADEYK4A2MAAAAASUVORK5CYII=';

// 320×160 的双色图，左上角有一块浅色：宽高不等、方向一眼能看出来，用来验证旋转和裁剪。由脚本生成。
const AVATAR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAACgCAIAAADywSLLAAACTklEQVR42u3TsQ0AEBRAQRuaxQBmsI7SPDqN2go68XPJG+Fd2mt+1yhZl9XWFbgEMMACGGCABTDAAAtgAQwwwAALYIABFsAAAyyAARbAAAMsgAEGWAALYIABBlgAAwywAAYYYAEsgAEGGGABDDDAAhhggAUwwAIYYIAFMMAAC2ABDDDAAAtggAEWwAADLIABFsAAAyyAAQZYAJMJsAAGWAADDLAABhhgASyAAQYYYAEMMMACGGCABTDAAhhggAUwwAALYAEMMMAAC2CAARbAAAMsgAUwwAADLIABBlgAAwywAAZYAAMMsAAGGGABLIABBhhgAQwwwAIYYIAFsCwOMMAAC2CAARbAAAMsgAFWCMAWB1gAC2ABLIAFsAAGWAALYAEsgAWwAAZYAAtgASyABbAABlgAC2ABLIAFsAAWwAALYAEsgAWwABbAAAtgASyABbAAFsAAC2ABLIAFsAAWwAALYAEsgAWwABbAAhhgASyABbAAFsACGGABLIAFsAAWwAIYYAEsgAWwABbAAhhglwMsgAWwABbAAlgAAyyABbAAFsACWAADLIAFsAAWwAJYAAMsgAWwABbAAlgAy+IAC2ABLIAFsAAWwAALYAEsgAWwABbAAAtgASyABbAAFsAAC2ABLIAFsAAWwAIYYAEsgAWwABbAAhhgASyABbAAFsACGGABLIAFsAAWwAIYYAEsgAWwABbAAlgAAyyABbAAFsACWAADLIAFsAAWwAJYAAMsgAWwABbAAlgAA+xygAWwABbAAlgAC2CABbAA1sMOYuQnSGqEqcAAAAAASUVORK5CYII=';

// 带 EXIF 的 JPEG：虚构的 GPS 和 Orientation=6，像素是 64×48 的渐变。由 e2e/helpers/jpeg-exif.mjs 生成。
// verify-uploads 查这张的原图还带着 GPS，它的预览和缩略图里已经没有了，并且方向转正了。
const EXIF_JPEG_BASE64 =
  '/9j/4QC/RXhpZgAASUkqAAgAAAADAA4BAgAfAAAAMgAAABIBAwABAAAABgAAACWIBAABAAAAUQAAAAAAAABYSUFPRE9VWUEgRklDVElPTkFMIFRFU1QgSU1BR0UABAABAAIAAgAAAE4AAAACAAUAAwAAAIcAAAADAAIAAgAAAEUAAAAEAAUAAwAAAJ8AAAAAAAAADAAAAAEAAAAiAAAAAQAAADgAAAABAAAAewAAAAEAAAAtAAAAAQAAAAYAAAABAAAA/+AAEEpGSUYAAQEAAAEAAQAA/9sAQwAKBwcIBwYKCAgICwoKCw4YEA4NDQ4dFRYRGCMfJSQiHyIhJis3LyYpNCkhIjBBMTQ5Oz4+PiUuRElDPEg3PT47/9sAQwEKCwsODQ4cEBAcOygiKDs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7/8AAEQgAMABAAwEiAAIRAQMRAf/EABYAAQEBAAAAAAAAAAAAAAAAAAAEB//EABYQAQEBAAAAAAAAAAAAAAAAAAATYf/EABcBAQADAAAAAAAAAAAAAAAAAAACAwX/xAAWEQEBAQAAAAAAAAAAAAAAAAAAERL/2gAMAwEAAhEDEQA/ANFqVR1Ks2tLKypVHUqUysqVR1KlMrKlUdSpTKOuldR1Ko1dlZXSuo6lSmVldK6jqVKZWV0rqOpUplHUqjqVQq/KypVHUqUysqVR1KlMrKlUdSpTL//Z';

// 最小的合法 PDF，能被系统阅读器打开。
const PDF_TEXT = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;

async function fixture(name: string, write: (file: File) => unknown): Promise<File> {
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  await write(file);
  return file;
}

/**
 * 超过分片阈值的样例。PNG 解码器会忽略 IEND 之后的内容，所以它还是一张能显示、能做缩略图的图，
 * 后面只是补足大小。内容用伪随机：全 0 时某些链路的压缩会让流量和进度对不上。
 */
async function bigFixture(name: string): Promise<File> {
  const file = await fixture(name, (f) => f.write(PNG_BASE64, { encoding: 'base64' }));
  const handle = file.open(FileMode.ReadWrite);
  try {
    handle.offset = handle.size ?? 0;
    const chunk = new Uint8Array(1024 * 1024);
    let seed = 0x2f6e2b1;
    let left = MULTIPART_THRESHOLD_BYTES + 1024 * 1024 - (handle.size ?? 0);
    while (left > 0) {
      for (let i = 0; i < chunk.length; i += 64) {
        // xorshift，够打乱就行。
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        chunk[i] = seed & 0xff;
      }
      const piece = left < chunk.length ? chunk.subarray(0, left) : chunk;
      await handle.writeBytes(piece);
      left -= piece.length;
    }
  } finally {
    handle.close();
  }
  return file;
}

/** 选两次就超过 100 个，流程 03a 要走到“放不下”的提示。 */
const BULK_PICK_COUNT = 60;
let fixtureSerial = 0;

/**
 * 流程 03a 要走“一次选很多张”，系统相册点不了，所以 E2E 构建里长按选图按钮给一批样例。
 * 每张的路径都不一样，和系统选择器一致：保存时文件是被挪走的。
 */
export async function e2eBulkMoment(): Promise<PickedFile[]> {
  const files: PickedFile[] = [];
  for (let i = 0; i < BULK_PICK_COUNT; i++) {
    if (i === 0) {
      const name = `e2e-bulk-${++fixtureSerial}.jpg`;
      const file = await fixture(name, (f) => f.write(EXIF_JPEG_BASE64, { encoding: 'base64' }));
      files.push({
        uri: file.uri,
        kind: 'image',
        mime: 'image/jpeg',
        size: file.size ?? 0,
        name,
        width: 48,
        height: 64,
      });
      continue;
    }
    const name = `e2e-bulk-${++fixtureSerial}.png`;
    // 最后一张走分片上传。放最后：时间线的封面还是小图，第二批超出上限时也正好被截掉。
    const file =
      i === BULK_PICK_COUNT - 1
        ? await bigFixture(name)
        : await fixture(name, (f) => f.write(PNG_BASE64, { encoding: 'base64' }));
    files.push({
      uri: file.uri,
      kind: 'image',
      mime: 'image/png',
      size: file.size ?? 0,
      name,
      width: 64,
      height: 64,
    });
  }
  return files;
}

export async function e2ePickFiles(
  purpose: 'moment' | 'avatar' | 'document-photo' | 'document-pdf' | 'feedback',
): Promise<PickedFile[]> {
  if (purpose === 'feedback') {
    // 带虚构 GPS 的样例：verify-uploads 核对传上去的那份已经没有 EXIF。
    const name = `e2e-feedback-${++fixtureSerial}.jpg`;
    const file = await fixture(name, (f) => f.write(EXIF_JPEG_BASE64, { encoding: 'base64' }));
    return [
      {
        uri: file.uri,
        kind: 'image',
        mime: 'image/jpeg',
        size: file.size ?? 0,
        name,
        width: 48,
        height: 64,
      },
    ];
  }
  if (purpose === 'document-pdf') {
    const file = await fixture('e2e-sample.pdf', (f) => f.write(PDF_TEXT));
    return [
      {
        uri: file.uri,
        kind: 'pdf',
        mime: 'application/pdf',
        size: file.size ?? 0,
        name: 'sample-certificate.pdf',
      },
    ];
  }
  if (purpose === 'avatar') {
    const file = await fixture('e2e-avatar.png', (f) =>
      f.write(AVATAR_PNG_BASE64, { encoding: 'base64' }),
    );
    return [
      {
        uri: file.uri,
        kind: 'image',
        mime: 'image/png',
        size: file.size ?? 0,
        name: 'e2e-avatar.png',
        width: 320,
        height: 160,
      },
    ];
  }
  const file = await fixture(`e2e-${purpose}.png`, (f) =>
    f.write(PNG_BASE64, { encoding: 'base64' }),
  );
  return [
    {
      uri: file.uri,
      kind: 'image',
      mime: 'image/png',
      size: file.size ?? 0,
      // 回忆用非 ASCII 的名字，流程 14b 要确认它能原样进相册（见 galleryUri）。
      name: purpose === 'moment' ? '小豆芽 笑脸.png' : 'e2e-sample.png',
      width: 64,
      height: 64,
    },
  ];
}
