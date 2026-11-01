/**
 * 上传队列里的文件路径。iOS 每次更新 App，容器路径里的 UUID 都可能变，
 * 存绝对路径的话，升级后所有没传完的文件都会变成“本地文件不见了”。
 * 所以存相对 Paths.document 的路径，读的时候再拼上当前的目录。
 * 不依赖 Expo，方便单元测试；documentUri 由调用方传入。
 */

const UPLOADS_SEGMENT = '/uploads/';

function isAbsolute(path: string): boolean {
  return path.startsWith('file:') || path.startsWith('/');
}

function withTrailingSlash(uri: string): string {
  return uri.endsWith('/') ? uri : `${uri}/`;
}

/** 写入队列时用。不在 App 文档目录下的路径原样保留，升级后找不到时队列会按“文件不见了”处理。 */
export function toStoredUploadPath(uri: string, documentUri: string): string {
  const root = withTrailingSlash(documentUri);
  return uri.startsWith(root) ? uri.slice(root.length) : uri;
}

/**
 * 读取队列时用。旧版本写的行是绝对路径：Android 的路径不会变，iOS 的容器可能已经换了，
 * 所以只要路径落在 uploads 目录下，就换成当前的文档目录，两种情况都对。
 */
export function resolveUploadPath(stored: string, documentUri: string): string {
  const root = withTrailingSlash(documentUri);
  if (!isAbsolute(stored)) return `${root}${stored}`;
  const at = stored.lastIndexOf(UPLOADS_SEGMENT);
  return at < 0 ? stored : `${root}${stored.slice(at + 1)}`;
}
