import { type DocumentData, documentCover, t } from '@xiaodouya/shared';
import { StyleSheet, Text } from 'react-native';
import { fileBadge } from '../lib/mediaUtils';
import { DocumentThumb } from '../lib/mediaViews';
import { colors } from '../theme';
import { Mono, PressScale, Stripes } from './primitives';

/**
 * 证件夹的卡片：资料页的宝宝证件和家人页的家人证件（F-137）共用。
 * 第二行默认是文件数，家人证件换成“谁能看”或“谁的”。
 */
export function DocumentCard({
  data,
  width,
  locked,
  footer,
  footerTone = 'muted',
  onPress,
}: {
  data: DocumentData;
  width: number;
  locked: boolean;
  footer?: string;
  footerTone?: 'muted' | 'accent';
  onPress: () => void;
}) {
  const files = data.files;
  const line = footer ?? (files.length ? t().info.fileCount(files.length) : t().info.toUpload);
  const tone = footer ? footerTone : files.length ? 'muted' : 'accent';
  return (
    <PressScale
      testID={`doc-card-${data.name}`}
      accessibilityLabel={data.name}
      scaleTo={0.97}
      style={[s.card, { width }]}
      onPress={onPress}
    >
      <DocCover name={data.name} files={files} locked={locked} />
      <Text style={s.name} numberOfLines={1}>
        {data.name}
      </Text>
      <Text
        numberOfLines={1}
        style={{ fontSize: 11, color: tone === 'accent' ? colors.accent : colors.muted }}
      >
        {line}
      </Text>
    </PressScale>
  );
}

/**
 * 证件卡片的上半部分：第一张照片的缩略图，一眼认得出是哪张证件。PDF 和拿不到缩略图时是类型标记，PDF 再加文件名。
 * 打开了证件夹指纹锁时只显示标记：资料页不在锁后面，不能在这里露出证件的样子。
 */
function DocCover({
  name,
  files,
  locked,
}: {
  name: string;
  files: DocumentData['files'];
  locked: boolean;
}) {
  const cover = documentCover(files);
  const pdfName = cover?.media.kind === 'pdf' ? cover.media.name : undefined;
  return (
    <Stripes style={s.thumb}>
      <Mono weight="medium" style={{ fontSize: 10, color: colors.muted }}>
        {cover ? fileBadge(cover.media) : t().info.emptyDoc}
      </Mono>
      {pdfName ? (
        <Text numberOfLines={1} style={s.fileName}>
          {pdfName}
        </Text>
      ) : null}
      {cover?.kind === 'thumb' && !locked ? (
        <DocumentThumb
          media={cover.media}
          testID={`doc-thumb-${name}`}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </Stripes>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 12,
    gap: 6,
  },
  thumb: {
    height: 88,
    borderRadius: 8,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 8,
  },
  fileName: { fontSize: 10, color: colors.muted, maxWidth: '100%' },
  name: { fontSize: 13, color: colors.ink },
});
