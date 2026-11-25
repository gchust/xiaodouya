import { SESSION_ALIGN } from '../src/blobs';

/**
 * 按文档行为模拟 Drive 的 HTTP 接口，只给 drive.ts 的测试用。真实 Drive 的行为要在接上真账号后再核对，
 * 见 PROGRESS。
 */
export function fakeDrive() {
  const files = new Map<string, { data: Uint8Array; parents: string[]; folder: boolean }>();
  const sessions = new Map<
    string,
    { total: number; parents: string[]; data: Uint8Array; received: number }
  >();
  const tokens = { issued: 0, refreshes: 0 };
  const requests: { method: string; url: string }[] = [];
  let next = 0;
  const id = () => `f${++next}`;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function handler(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, url: url.origin + url.pathname });
    if (url.href === 'https://oauth2.googleapis.com/token') {
      tokens.refreshes++;
      const form = new URLSearchParams(await request.text());
      if (form.get('refresh_token') !== 'refresh') return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: `token-${++tokens.issued}`, expires_in: 3600 });
    }
    if (!/^Bearer token-\d+$/.test(request.headers.get('authorization') ?? '')) {
      return json(401, { error: 'unauthenticated' });
    }
    if (url.pathname === '/drive/v3/files' && request.method === 'POST') {
      const meta = (await request.json()) as { mimeType?: string; parents: string[] };
      const fid = id();
      files.set(fid, {
        data: new Uint8Array(),
        parents: meta.parents,
        folder: meta.mimeType === 'application/vnd.google-apps.folder',
      });
      return json(200, { id: fid });
    }
    if (
      url.pathname === '/upload/drive/v3/files' &&
      url.searchParams.get('uploadType') === 'resumable' &&
      !url.searchParams.has('upload_id')
    ) {
      const meta = (await request.json()) as { parents: string[] };
      const total = Number(request.headers.get('x-upload-content-length'));
      const sid = `s${++next}`;
      sessions.set(sid, { total, parents: meta.parents, data: new Uint8Array(total), received: 0 });
      return new Response(null, {
        status: 200,
        headers: {
          location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}`,
        },
      });
    }
    const sid = url.searchParams.get('upload_id');
    if (sid && request.method === 'PUT') {
      const s = sessions.get(sid);
      if (!s) return json(404, { error: 'session' });
      const range = request.headers.get('content-range') ?? '';
      const status = /^bytes \*\/(\d+)$/.exec(range);
      const rangeHeader = (): Record<string, string> =>
        s.received > 0 ? { range: `bytes=0-${s.received - 1}` } : {};
      if (status) return new Response(null, { status: 308, headers: rangeHeader() });
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      if (!m) return json(400, { error: 'range' });
      const start = Number(m[1]);
      const end = Number(m[2]);
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.length !== end - start + 1 || start !== s.received)
        return json(400, { error: 'offset' });
      const last = end + 1 === s.total;
      if (!last && body.length % SESSION_ALIGN !== 0) return json(400, { error: 'align' });
      s.data.set(body, start);
      s.received = end + 1;
      if (!last) return new Response(null, { status: 308, headers: rangeHeader() });
      sessions.delete(sid);
      const fid = id();
      files.set(fid, { data: s.data, parents: s.parents, folder: false });
      return json(200, { id: fid });
    }
    const file = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (file) {
      const f = files.get(decodeURIComponent(file[1]!));
      if (request.method === 'DELETE') {
        if (!f) return json(404, {});
        files.delete(decodeURIComponent(file[1]!));
        return new Response(null, { status: 204 });
      }
      if (request.method === 'GET' && url.searchParams.get('alt') === 'media') {
        if (!f) return json(404, {});
        const r = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? '');
        if (!r) return new Response(f.data.slice(), { status: 200 });
        return new Response(f.data.slice(Number(r[1]), Number(r[2]) + 1), { status: 206 });
      }
    }
    return json(400, { error: 'unexpected request' });
  }

  return { fetch: handler as typeof fetch, files, sessions, tokens, requests };
}
