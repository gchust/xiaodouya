import { File, Paths } from 'expo-file-system';
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
    const name = `e2e-bulk-${++fixtureSerial}.png`;
    const file = await fixture(name, (f) => f.write(PNG_BASE64, { encoding: 'base64' }));
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
  purpose: 'moment' | 'avatar' | 'document-photo' | 'document-pdf',
): Promise<PickedFile[]> {
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
