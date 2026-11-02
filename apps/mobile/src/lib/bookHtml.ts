import {
  type BabyData,
  dayLabel,
  formatFullDate,
  getLocale,
  type LetterData,
  type MomentData,
  type PaperSize,
  t,
} from '@xiaodouya/shared';
import { escapeHtml } from './mediaUtils';

export interface BookPhoto {
  /** data: URI，保证打印时不依赖网络和链接有效期。 */
  src: string;
}

export interface BookMoment {
  data: MomentData;
  photos: BookPhoto[];
}

/** 纯函数：只负责拼 HTML，便于测试转义和排版结构。 */
export function buildBookHtml(
  baby: BabyData,
  moments: BookMoment[],
  letters: LetterData[],
): string {
  const text = t().ui;
  const momentHtml = moments
    .slice()
    .sort((a, b) => a.data.at - b.data.at)
    .map(({ data, photos }) => {
      const images = photos.map((p) => `<img src="${p.src}" />`).join('');
      return `<article>
  <h2>${escapeHtml(data.title || text.thisMoment)}</h2>
  <p class="meta">${formatFullDate(data.at)} · ${dayLabel(baby.birthAt, data.at)}${data.milestone ? text.bookMilestoneSuffix : ''}</p>
  ${images ? `<div class="photos">${images}</div>` : ''}
  ${data.text ? `<p class="text">${escapeHtml(data.text)}</p>` : ''}
  ${data.byName ? `<p class="by">${text.bookBy(escapeHtml(data.byName))}</p>` : ''}
</article>`;
    })
    .join('\n');
  const letterHtml = letters
    .slice()
    .sort((a, b) => a.at - b.at)
    .map(
      (l) => `<article class="letter">
  <h2>${escapeHtml(l.title || text.untitled)}</h2>
  <p class="meta">${formatFullDate(l.at)}</p>
  <p class="text">${escapeHtml(l.text)}</p>
  ${l.byName ? `<p class="by">${text.bookBy(escapeHtml(l.byName))}</p>` : ''}
</article>`,
    )
    .join('\n');
  const name = escapeHtml(baby.name);
  return `<!doctype html><html lang="${getLocale()}"><head><meta charset="utf-8" /><style>
  @page { margin: 22mm 18mm; }
  body { font-family: "Noto Serif CJK SC", "Noto Serif SC", serif; color: #2b2622; background: #fff; }
  .cover { height: 90vh; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
  .cover h1 { font-size: 40pt; margin: 0 0 12pt; }
  .cover p { color: #7a6f66; font-size: 13pt; margin: 0; }
  h2 { font-size: 18pt; margin: 0 0 4pt; }
  .meta { color: #7a6f66; font-size: 10pt; margin: 0 0 10pt; font-family: monospace; }
  article { margin-bottom: 26pt; page-break-inside: avoid; }
  .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 6pt; margin-bottom: 10pt; }
  .photos img { width: 100%; height: 180pt; object-fit: cover; border-radius: 6pt; }
  .text { font-size: 12pt; line-height: 1.9; margin: 0 0 6pt; white-space: pre-wrap; }
  .by { color: #7a6f66; font-size: 10pt; margin: 0; }
  .section { font-size: 24pt; margin: 0 0 18pt; color: #c0714f; page-break-before: always; }
</style></head><body>
<section class="cover"><h1>${text.bookTitle(name)}</h1><p>${text.bookBornOn(formatFullDate(baby.birthAt))}</p></section>
${momentHtml ? `<h1 class="section" style="page-break-before:auto">${text.bookMemories}</h1>${momentHtml}` : ''}
${letterHtml ? `<h1 class="section">${text.bookLetters}</h1>${letterHtml}` : ''}
</body></html>`;
}

const PAGES: Record<PaperSize, { width: number; height: number }> = {
  A4: { width: 595, height: 842 },
  Letter: { width: 612, height: 792 },
};

/** 打印的页面大小（单位是点），各地区常用的纸不一样，见地区配置的 `paperSize`。 */
export function bookPage(paper: PaperSize): { width: number; height: number } {
  return PAGES[paper];
}

/** 分享和保存时用户会看到文件名，不能是一串随机 id。去掉文件系统不允许的字符。 */
export function bookFileName(babyName: string): string {
  const safe = babyName.replace(/[\\/:*?"<>|]/g, '').trim();
  return t().ui.bookFile(safe || t().ui.baby);
}
