import {
  type BabyData,
  type LetterData,
  type MediaRef,
  type MomentData,
  regionFor,
} from '@xiaodouya/shared';
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { Api } from './api';
import { type BookMoment, type BookPhoto, bookFileName, bookPage, buildBookHtml } from './bookHtml';
import { localUriFor } from './media';

const MAX_PHOTOS_PER_MOMENT = 6;

function localCopy(media: MediaRef): string | null {
  return (
    (media.hasThumb ? localUriFor(media.id, 'thumb') : null) ?? localUriFor(media.id, 'original')
  );
}

async function toDataUri(uri: string): Promise<string> {
  const base64 = await new File(uri).base64();
  return `data:image/jpeg;base64,${base64}`;
}

export async function exportGrowthBook(
  api: Api,
  baby: BabyData,
  moments: { data: MomentData }[],
  letters: { data: LetterData }[],
): Promise<void> {
  if (moments.length === 0 && letters.length === 0) {
    throw new Error('还没有回忆和信，先记下一些吧');
  }
  const wanted = moments.map((m) => ({
    data: m.data,
    media: m.data.media.filter((x) => x.kind === 'image').slice(0, MAX_PHOTOS_PER_MOMENT),
  }));
  const remote = wanted
    .flatMap((m) => m.media)
    .filter((x) => !localCopy(x))
    .map((x) => ({ id: x.id, variant: x.hasThumb ? ('thumb' as const) : ('original' as const) }));
  const urls = new Map<string, string>();
  for (let i = 0; i < remote.length; i += 200) {
    const { urls: page } = await api.mediaUrls(remote.slice(i, i + 200));
    for (const u of page) if (u.url) urls.set(u.id, u.url);
  }
  // 缩略图可能还在排队，也可能做不出来（比如解码失败）。这时用原图，不能让照片从册子里消失。
  const noThumb = remote.filter((r) => r.variant === 'thumb' && !urls.has(r.id));
  for (let i = 0; i < noThumb.length; i += 200) {
    const page = noThumb.slice(i, i + 200).map((r) => ({ id: r.id, variant: 'original' as const }));
    const { urls: originals } = await api.mediaUrls(page);
    for (const u of originals) if (u.url) urls.set(u.id, u.url);
  }
  const book: BookMoment[] = [];
  for (const moment of wanted) {
    const photos: BookPhoto[] = [];
    for (const media of moment.media) {
      try {
        let uri = localCopy(media);
        if (!uri) {
          const url = urls.get(media.id);
          if (!url) continue;
          const target = new File(Paths.cache, `book-${media.id}`);
          if (target.exists) target.delete();
          uri = (await File.downloadFileAsync(url, target)).uri;
        }
        photos.push({ src: await toDataUri(uri) });
      } catch {
        // 单张失败不影响整本册子。
      }
    }
    book.push({ data: moment.data, photos });
  }
  const html = buildBookHtml(
    baby,
    book,
    letters.map((l) => l.data),
  );
  const page = bookPage(regionFor(baby.region).paperSize);
  const printed = await Print.printToFileAsync({ html, ...page });
  const target = new File(Paths.cache, bookFileName(baby.name));
  if (target.exists) target.delete();
  await new File(printed.uri).move(target);
  await Sharing.shareAsync(target.uri, {
    mimeType: 'application/pdf',
    dialogTitle: `${baby.name}的成长册`,
  });
}
