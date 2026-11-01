import { File, Paths } from 'expo-file-system';
import type { PickedFile } from './media';

/**
 * E2E 构建用这些内置样例代替系统选择器。系统相册的界面随 Android 版本变化，
 * 在 CI 上点它很不稳定；选择器之后的复制、缩略图、直传、完成校验走的都是真实代码。
 * 样例是一张 64×64 的渐变图，由 ImageMagick 生成。
 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAsElEQVRo3u3YwQnEQAwDwF24/lJLOkxpV4QfYoy2Ag+WRcj93ufI73fvTc8wAxwdcI8OsOffEKECwgA/Qn4L4QB8ASs2gAP4DfAt1AjlAekRhoBGKA5oC4UBfoR0AH4CC454QYRwAL8BHuBHKD3BFOBvoIAwoBGKA/RvIXz+DRHSAX4L4UfQCKWf/2+0EUoD2kJpgB8hHYCfwIIN8C3UIy5gCFgQofQIU0BbKAzQj/gPXRADEYK4A2MAAAAASUVORK5CYII=';

// 最小的合法 PDF，能被系统阅读器打开。
const PDF_TEXT = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;

function fixture(name: string, write: (file: File) => void): File {
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  write(file);
  return file;
}

export async function e2ePickFiles(
  purpose: 'moment' | 'document-photo' | 'document-pdf',
): Promise<PickedFile[]> {
  if (purpose === 'document-pdf') {
    const file = fixture('e2e-sample.pdf', (f) => f.write(PDF_TEXT));
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
  const file = fixture(`e2e-${purpose}.png`, (f) => f.write(PNG_BASE64, { encoding: 'base64' }));
  return [
    {
      uri: file.uri,
      kind: 'image',
      mime: 'image/png',
      size: file.size ?? 0,
      name: 'e2e-sample.png',
      width: 64,
      height: 64,
    },
  ];
}
