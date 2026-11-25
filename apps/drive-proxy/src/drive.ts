import { type BlobLabel, BlobNotFound, type BlobStore } from './blobs';
import type { Db } from './db';

/**
 * 用 Google Drive 存块。授权范围是 `drive.file`：只能看到这个应用自己建的文件，碰不到 Drive 里别的东西。
 * 文件分进 256 个子文件夹：一个普通文件夹最多直接放 50 万个文件。
 *
 * 接口文档：
 * - 续传上传 https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable
 * - 下载 https://developers.google.com/workspace/drive/api/guides/manage-downloads
 * - 刷新令牌 https://developers.google.com/identity/protocols/oauth2/web-server#offline
 */
export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** 放文件的文件夹。不填就在 Drive 根目录建一个。 */
  rootFolderId: string | null;
}

interface DriveDeps {
  fetch: typeof fetch;
  db: Db;
  /** Workers 要用 FixedLengthStream 包一层，fetch 才会带 Content-Length。 */
  fixedLength(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array>;
}

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_FOLDER_NAME = 'xiaodouya-files';

/** 错误里只放状态码：响应可能带会话地址，日志里不能有。 */
export class DriveError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`drive ${operation} failed: ${status}`);
    this.name = 'DriveError';
  }
}

/** 访问令牌一小时有效，按刷新令牌缓存在 isolate 里，免得每个请求都去换。 */
const tokens = new Map<string, { token: string; expiresAt: number }>();

export function driveBlobs(config: DriveConfig, deps: DriveDeps): BlobStore {
  async function accessToken(): Promise<string> {
    const cached = tokens.get(config.refreshToken);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const response = await deps.fetch(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      // 400 invalid_grant 多半是授权被撤销，或者 OAuth 应用还在“测试”状态（7 天过期）。
      throw new DriveError('token', response.status);
    }
    const json = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== 'string' || typeof json.expires_in !== 'number') {
      throw new DriveError('token', 502);
    }
    tokens.set(config.refreshToken, {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    });
    return json.access_token;
  }

  async function call(
    operation: string,
    url: string,
    init: RequestInit & { headers?: Record<string, string> },
  ): Promise<Response> {
    const token = await accessToken();
    return deps
      .fetch(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
        duplex: 'half',
      } as RequestInit)
      .catch(() => {
        throw new DriveError(operation, 0);
      });
  }

  async function createFolder(name: string, parent: string): Promise<string> {
    const response = await call('folder', `${API}?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DriveError('folder', response.status);
    }
    return idOf(await response.json(), 'folder');
  }

  /** 文件夹 id 记在 D1 里。两个请求同时建同一个文件夹时以先写进 D1 的为准，另一个空着也不影响。 */
  async function folder(name: string, parent: () => Promise<string>): Promise<string> {
    const known = await deps.db
      .prepare('SELECT drive_id FROM folders WHERE name = ?')
      .bind(name)
      .first<{ drive_id: string }>();
    if (known) return known.drive_id;
    const created = await createFolder(name || ROOT_FOLDER_NAME, await parent());
    await deps.db
      .prepare('INSERT OR IGNORE INTO folders (name, drive_id) VALUES (?, ?)')
      .bind(name, created)
      .run();
    const winner = await deps.db
      .prepare('SELECT drive_id FROM folders WHERE name = ?')
      .bind(name)
      .first<{ drive_id: string }>();
    return winner?.drive_id ?? created;
  }

  const root = () =>
    config.rootFolderId ? Promise.resolve(config.rootFolderId) : folder('', async () => 'root');

  async function shard(): Promise<string> {
    const name = `xdy-${crypto.getRandomValues(new Uint8Array(1))[0]!.toString(16).padStart(2, '0')}`;
    return folder(name, root);
  }

  async function startUpload(total: number, label: BlobLabel): Promise<string> {
    const parent = await shard();
    const response = await call('start', `${UPLOAD}?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'application/octet-stream',
        'x-upload-content-length': String(total),
      },
      body: JSON.stringify({ ...fileMetadata(label), parents: [parent] }),
    });
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!response.ok || !location) throw new DriveError('start', response.status);
    return location;
  }

  async function sendRange(
    session: string,
    body: ReadableStream<Uint8Array>,
    offset: number,
    size: number,
    total: number,
  ): Promise<string | null> {
    const headers: Record<string, string> = {};
    if (size > 0) headers['content-range'] = `bytes ${offset}-${offset + size - 1}/${total}`;
    else headers['content-range'] = `bytes */${total}`;
    const response = await call('append', session, {
      method: 'PUT',
      headers,
      body: size > 0 ? deps.fixedLength(body, size) : null,
    });
    if (response.status === 308) {
      await response.body?.cancel();
      if (offset + size === total) throw new DriveError('append', 308);
      return null;
    }
    if (response.status === 200 || response.status === 201) {
      return idOf(await response.json(), 'append');
    }
    await response.body?.cancel();
    throw new DriveError('append', response.status);
  }

  return {
    async put(body, size, label) {
      const session = await startUpload(size, label);
      const id = await sendRange(session, body, 0, size, size);
      if (!id) throw new DriveError('put', 308);
      return id;
    },

    async get(id, start, end) {
      const response = await call('get', `${API}/${encodeURIComponent(id)}?alt=media`, {
        headers: { range: `bytes=${start}-${end}` },
      });
      if (response.status === 404) {
        await response.body?.cancel();
        throw new BlobNotFound(id);
      }
      if ((response.status !== 206 && response.status !== 200) || !response.body) {
        await response.body?.cancel();
        throw new DriveError('get', response.status);
      }
      return response.body;
    },

    // 放进回收站而不是永久删除：Drive 30 天后自己清掉，这期间元数据写错了还能救回来。
    async delete(id) {
      const response = await call('delete', `${API}/${encodeURIComponent(id)}?fields=id`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ trashed: true }),
      });
      await response.body?.cancel();
      if (response.status !== 200 && response.status !== 404) {
        throw new DriveError('delete', response.status);
      }
    },

    startSession: startUpload,

    async sessionOffset(session, total) {
      const response = await call('status', session, {
        method: 'PUT',
        headers: { 'content-range': `bytes */${total}` },
      });
      if (response.status === 308) {
        await response.body?.cancel();
        const range = response.headers.get('range');
        const m = range ? /^bytes=0-(\d+)$/.exec(range) : null;
        return m ? Number(m[1]) + 1 : 0;
      }
      // 上次已经传完、只是没来得及记下：响应里有文件 id，直接用，不重新合并。
      if (response.status === 200 || response.status === 201) {
        return { blobId: idOf(await response.json(), 'status') };
      }
      await response.body?.cancel();
      // 404/410：会话过期了，从头再来。
      if (response.status === 404 || response.status === 410) return null;
      throw new DriveError('status', response.status);
    },

    append: sendRange,
  };
}

/**
 * 文件自己带着它是谁：description 是 object key，名字是版本和片号，appProperties 标明是这个代理建的。
 * 元数据库没了的时候，按这些能把文件对回 object key。
 */
function fileMetadata(label: BlobLabel) {
  return {
    name: `${label.version.replace(/"/g, '')}-${label.part ?? 'all'}`,
    description: label.key,
    appProperties: { xdy: '1', part: String(label.part ?? 'all') },
  };
}

function idOf(json: unknown, operation: string): string {
  const id = (json as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id) throw new DriveError(operation, 502);
  return id;
}
