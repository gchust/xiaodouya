import { describe, expect, it, vi } from 'vitest';
import {
  createDownloader,
  DownloadGone,
  type DownloadPorts,
  downloadFileNames,
  downloadMessage,
  FolderNameTakenError,
  galleryUri,
  numberedFileName,
  safeFileName,
  saveTargetFor,
} from '../src/lib/downloadCore';

const SIGNED = 'https://s3.example.test/obj?X-Amz-Signature=secret';

describe('下载的文件名', () => {
  const photo = { id: 'a', kind: 'image', mime: 'image/jpeg' } as const;
  const context = { title: '第一次笑', at: new Date(2026, 9, 6, 12).getTime() };
  const nameOf = (media: Parameters<typeof downloadFileNames>[0][number]) =>
    downloadFileNames([media], context).get(media.id);

  it('优先用原来的名字', () => {
    expect(nameOf({ ...photo, name: 'IMG_0001.JPG' })).toBe('IMG_0001.JPG');
  });
  it('没有名字时用标题和日期', () => {
    expect(nameOf(photo)).toBe('第一次笑 2026-10-06.jpg');
  });
  it('没有日期时只用标题，证件不需要日期', () => {
    const names = downloadFileNames([{ id: 'p', kind: 'pdf', mime: 'application/pdf' }], {
      title: '出生证明',
    });
    expect(names.get('p')).toBe('出生证明.pdf');
  });
  it('录音的名字里有点号，不能当成扩展名', () => {
    const audio = { id: 'r', kind: 'audio', mime: 'audio/mp4', name: '录音 · 03.14' } as const;
    expect(nameOf(audio)).toBe('录音 · 03.14.m4a');
  });
  it('扩展名和类型不符时补上正确的，否则相册认错类型', () => {
    expect(nameOf({ ...photo, name: 'scan.png' })).toBe('scan.png.jpg');
  });
  it('类型不认识时按种类补扩展名', () => {
    const unknown = { id: 'v', kind: 'video', mime: 'application/octet-stream' } as const;
    expect(nameOf({ ...unknown, name: 'clip' })).toBe('clip.mp4');
    expect(nameOf({ ...unknown, name: 'clip.mov' })).toBe('clip.mov');
  });
  it('同一条回忆里没有名字或同名的文件不会重复', () => {
    const names = downloadFileNames(
      [
        { ...photo, id: '1' },
        { ...photo, id: '2' },
        { ...photo, id: '3', name: 'a.jpg' },
        { ...photo, id: '4', name: 'A.JPG' },
      ],
      context,
    );
    expect([...names.values()]).toEqual([
      '第一次笑 2026-10-06.jpg',
      '第一次笑 2026-10-06 (2).jpg',
      'a.jpg',
      'A (2).JPG',
    ]);
  });
});

describe('文件名里的非法字符', () => {
  it('去掉系统不允许的字符和路径', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j.jpg')).toBe('a_b_c_d_e_f_g_h_i_j.jpg');
    expect(safeFileName('../../etc/passwd')).toBe('etc_passwd');
  });
  it('去掉控制字符和能伪装扩展名的方向符', () => {
    expect(safeFileName('a\u0000b\nc.jpg')).toBe('abc.jpg');
    expect(safeFileName('photo‮gpj.exe')).toBe('photogpj.exe');
  });
  it('不把各国文字当非法字符', () => {
    for (const name of ['はじめて.jpg', '첫 미소.jpg', 'Première fois.jpg', 'صورة.jpg', '😀.jpg']) {
      expect(safeFileName(name)).toBe(name);
    }
  });
  it('开头的点和结尾的点、空格都去掉', () => {
    expect(safeFileName('  ..hidden.jpg. ')).toBe('hidden.jpg');
  });
  it('全是非法字符时是空的，调用方退回标题', () => {
    expect(safeFileName('///')).toBe('');
  });
  it('Windows 保留名加前缀，文件以后可能拷到电脑上', () => {
    expect(safeFileName('CON.pdf')).toBe('_CON.pdf');
  });
  it('按字节截断，保留扩展名，不切开表情符号', () => {
    const name = safeFileName(`${'😀'.repeat(200)}.jpg`);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
    expect(name.endsWith('.jpg')).toBe(true);
    expect(name).not.toContain('�');
    expect([...name.slice(0, -4)].every((c) => c === '😀')).toBe(true);
  });
});

describe('重名时加序号', () => {
  it('序号在扩展名前面', () => {
    expect(numberedFileName('a.pdf', 1)).toBe('a.pdf');
    expect(numberedFileName('a.pdf', 2)).toBe('a (2).pdf');
    expect(numberedFileName('录音 · 03.14.m4a', 3)).toBe('录音 · 03.14 (3).m4a');
    expect(numberedFileName('noext', 2)).toBe('noext (2)');
  });
});

describe('存到哪里', () => {
  it('回忆的照片和视频进相册', () => {
    for (const kind of ['image', 'video'] as const) {
      expect(saveTargetFor({ kind }, { sensitive: false, platform: 'android' })).toBe('gallery');
      expect(saveTargetFor({ kind }, { sensitive: false, platform: 'ios' })).toBe('gallery');
    }
  });
  it('证件图片不能默默进相册', () => {
    expect(saveTargetFor({ kind: 'image' }, { sensitive: true, platform: 'android' })).toBe(
      'folder',
    );
    expect(saveTargetFor({ kind: 'image' }, { sensitive: true, platform: 'ios' })).toBe('share');
  });
  it('录音和 PDF 由用户选位置', () => {
    expect(saveTargetFor({ kind: 'audio' }, { sensitive: false, platform: 'android' })).toBe(
      'folder',
    );
    expect(saveTargetFor({ kind: 'pdf' }, { sensitive: true, platform: 'android' })).toBe('folder');
  });
});

describe('交给相册的地址', () => {
  // Android 的 MimeTypeMap.getFileExtensionFromUrl：文件名不符合这个规则就取不到扩展名，
  // 视频会被当成类型未知的图片写进相册。
  const ANDROID_FILENAME = /^[a-zA-Z_0-9.\-()%]+$/;
  const lastSegment = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

  it('文件名编码后能让 Android 认出扩展名，还原后不变', () => {
    for (const name of ['第一次笑 2026-10-06.mp4', "a,b+c&d!e'f~g.mp4", '😀 (2).mp4']) {
      const uri = galleryUri(`file:///cache/downloads/x/${name.replace(/ /g, '%20')}`);
      expect(lastSegment(uri)).toMatch(ANDROID_FILENAME);
      expect(decodeURIComponent(lastSegment(uri))).toBe(name);
    }
  });
  it('目录部分不动，已经编码的不会编码两次', () => {
    expect(galleryUri('file:///data/user/0/x/a%20b.jpg')).toBe('file:///data/user/0/x/a%20b.jpg');
  });
});

describe('给用户看的提示', () => {
  it('不会把原始错误带给用户', () => {
    const texts = ['permission', 'not-ready', 'network', 'no-space', 'incomplete', 'save'] as const;
    for (const reason of texts) {
      const text = downloadMessage({ status: 'failed', reason });
      expect(text).toBeTruthy();
      expect(text).not.toContain('http');
    }
  });
  it('保存成功说清楚在哪，分享和选择位置时取消都不打扰', () => {
    expect(downloadMessage({ status: 'saved', target: 'gallery' })).toBe('已保存到相册');
    expect(downloadMessage({ status: 'saved', target: 'folder' })).toBe('已保存到你选的文件夹');
    expect(downloadMessage({ status: 'saved', target: 'share' })).toBeNull();
    expect(downloadMessage({ status: 'cancelled', quiet: true })).toBeNull();
    expect(downloadMessage({ status: 'cancelled', quiet: false })).toBe('已取消下载');
  });
});

type Ports = { [K in keyof DownloadPorts]: ReturnType<typeof vi.fn> & DownloadPorts[K] };

function fakePorts(overrides: Partial<DownloadPorts> = {}): Ports {
  const base: DownloadPorts = {
    requestGalleryAccess: async () => true,
    pickFolder: async () => 'content://folder',
    findLocalCopy: async () => null,
    signedUrl: async () => SIGNED,
    availableBytes: () => 1_000_000,
    prepareTemp: (id, name) => `file:///cache/downloads/${id}/${name}`,
    fetchTo: async () => {},
    copyInto: async () => {},
    sizeOf: () => 100,
    saveToGallery: async () => {},
    saveToFolder: async () => {},
    renameTemp: (uri, name) => `${uri.slice(0, uri.lastIndexOf('/') + 1)}${name}`,
    share: async () => {},
    removeTemp: () => {},
  };
  const merged = { ...base, ...overrides };
  return Object.fromEntries(
    Object.entries(merged).map(([key, fn]) => [key, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as Ports;
}

const photo = { id: 'p1', kind: 'image', mime: 'image/png', size: 100 } as const;
const pdf = { id: 'd1', kind: 'pdf', mime: 'application/pdf', size: 100 } as const;
const android = { platform: 'android' };

describe('下载流程', () => {
  it('照片：取链接、下载、进相册、清掉临时文件', async () => {
    const ports = fakePorts();
    const d = createDownloader(ports, android);
    const outcome = await d.start({ media: photo, fileName: 'a.png', sensitive: false });
    expect(outcome).toEqual({ status: 'saved', target: 'gallery' });
    expect(ports.fetchTo).toHaveBeenCalledTimes(1);
    expect(ports.saveToGallery).toHaveBeenCalledWith('file:///cache/downloads/p1/a.png');
    expect(ports.pickFolder).not.toHaveBeenCalled();
    expect(ports.removeTemp).toHaveBeenLastCalledWith('p1');
    expect(d.stateOf('p1')).toBeNull();
  });

  it('手机上已有完整副本就不再下载，也不用取链接', async () => {
    const ports = fakePorts({ findLocalCopy: async () => 'file:///uploads/p1-original' });
    await createDownloader(ports, android).start({
      media: photo,
      fileName: 'a.png',
      sensitive: false,
    });
    expect(ports.signedUrl).not.toHaveBeenCalled();
    expect(ports.fetchTo).not.toHaveBeenCalled();
    expect(ports.copyInto).toHaveBeenCalledWith(
      'file:///uploads/p1-original',
      'file:///cache/downloads/p1/a.png',
    );
    expect(ports.saveToGallery).toHaveBeenCalledTimes(1);
  });

  it('相册没有权限：不下载就告诉用户', async () => {
    const ports = fakePorts({ requestGalleryAccess: async () => false });
    const outcome = await createDownloader(ports, android).start({
      media: photo,
      fileName: 'a.png',
      sensitive: false,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'permission' });
    expect(ports.fetchTo).not.toHaveBeenCalled();
  });

  it('证件：先选位置再取链接，不进相册，临时文件总会清掉', async () => {
    const calls: string[] = [];
    const ports = fakePorts({
      pickFolder: async () => {
        calls.push('pick');
        return 'content://folder';
      },
      signedUrl: async () => {
        calls.push('url');
        return SIGNED;
      },
    });
    const outcome = await createDownloader(ports, android).start({
      media: { ...photo, id: 'd2' },
      fileName: 'id.png',
      sensitive: true,
    });
    expect(outcome).toEqual({ status: 'saved', target: 'folder' });
    expect(calls).toEqual(['pick', 'url']);
    expect(ports.saveToGallery).not.toHaveBeenCalled();
    expect(ports.removeTemp).toHaveBeenLastCalledWith('d2');
  });

  it('不选位置就安静地结束，什么都不下载', async () => {
    const ports = fakePorts({ pickFolder: async () => null });
    const outcome = await createDownloader(ports, android).start({
      media: pdf,
      fileName: 'a.pdf',
      sensitive: true,
    });
    expect(outcome).toEqual({ status: 'cancelled', quiet: true });
    expect(ports.signedUrl).not.toHaveBeenCalled();
  });

  it('文件夹里重名就换下一个序号', async () => {
    const attempts: string[] = [];
    const ports = fakePorts({
      saveToFolder: async (uri) => {
        attempts.push(uri);
        if (attempts.length < 3) throw new FolderNameTakenError();
      },
    });
    const outcome = await createDownloader(ports, android).start({
      media: pdf,
      fileName: 'a.pdf',
      sensitive: true,
    });
    expect(outcome).toEqual({ status: 'saved', target: 'folder' });
    expect(attempts).toEqual([
      'file:///cache/downloads/d1/a.pdf',
      'file:///cache/downloads/d1/a (2).pdf',
      'file:///cache/downloads/d1/a (3).pdf',
    ]);
  });

  it('文件还没上传完：说明原因，不去下载', async () => {
    const ports = fakePorts({ signedUrl: async () => null });
    const outcome = await createDownloader(ports, android).start({
      media: photo,
      fileName: 'a.png',
      sensitive: false,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'not-ready' });
    expect(ports.fetchTo).not.toHaveBeenCalled();
  });

  it('下载失败不崩，错误信息里的签名链接不外传，可以再点一次', async () => {
    let tries = 0;
    const ports = fakePorts({
      fetchTo: async () => {
        tries += 1;
        if (tries === 1) throw new Error(`failed to connect ${SIGNED}`);
      },
    });
    const d = createDownloader(ports, android);
    const request = { media: photo, fileName: 'a.png', sensitive: false };
    const first = await d.start(request);
    expect(first).toEqual({ status: 'failed', reason: 'network' });
    expect(JSON.stringify(first)).not.toContain('Signature');
    expect(ports.removeTemp).toHaveBeenLastCalledWith('p1');
    expect(ports.saveToGallery).not.toHaveBeenCalled();
    expect(await d.start(request)).toEqual({ status: 'saved', target: 'gallery' });
  });

  it('下载不完整不能当成功：大小对不上就不保存', async () => {
    const ports = fakePorts({ sizeOf: () => 42 });
    const outcome = await createDownloader(ports, android).start({
      media: photo,
      fileName: 'a.png',
      sensitive: false,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'incomplete' });
    expect(ports.saveToGallery).not.toHaveBeenCalled();
    expect(ports.removeTemp).toHaveBeenLastCalledWith('p1');
  });

  it('空间明显不够就不开始', async () => {
    const ports = fakePorts({ availableBytes: () => 10 });
    const outcome = await createDownloader(ports, android).start({
      media: photo,
      fileName: 'a.png',
      sensitive: false,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'no-space' });
    expect(ports.signedUrl).not.toHaveBeenCalled();
  });

  it('保存失败要提示，临时文件照样清掉', async () => {
    const ports = fakePorts({
      saveToGallery: async () => {
        throw new Error('disk');
      },
    });
    const outcome = await createDownloader(ports, android).start({
      media: photo,
      fileName: 'a.png',
      sensitive: false,
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'save' });
    expect(ports.removeTemp).toHaveBeenLastCalledWith('p1');
  });

  it('清理临时文件出错也不影响结果', async () => {
    const ports = fakePorts({
      removeTemp: () => {
        throw new Error('gone');
      },
    });
    const outcome = await createDownloader(ports, android).start({
      media: photo,
      fileName: 'a.png',
      sensitive: false,
    });
    expect(outcome).toEqual({ status: 'saved', target: 'gallery' });
  });

  it('进度按百分比通知，总大小未知时用记录里的大小', async () => {
    const seen: (number | null)[] = [];
    const ports = fakePorts({
      fetchTo: async (_url, _to, options) => {
        options.onProgress(50, 100);
        options.onProgress(50, 100);
        options.onProgress(75, -1);
      },
    });
    const d = createDownloader(ports, android);
    const unsubscribe = d.subscribe(() => {
      const state = d.stateOf('p1');
      if (state?.phase === 'downloading') seen.push(state.fraction);
    });
    await d.start({ media: photo, fileName: 'a.png', sensitive: false });
    unsubscribe();
    expect(seen).toEqual([0, 0.5, 0.75]);
  });

  it('下载中再点同一个文件不会开第二份', async () => {
    let release: () => void = () => {};
    const ports = fakePorts({
      fetchTo: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const d = createDownloader(ports, android);
    const request = { media: photo, fileName: 'a.png', sensitive: false };
    const first = d.start(request);
    await vi.waitFor(() => expect(ports.fetchTo).toHaveBeenCalled());
    expect(await d.start(request)).toEqual({ status: 'busy' });
    release();
    expect(await first).toEqual({ status: 'saved', target: 'gallery' });
    expect(ports.fetchTo).toHaveBeenCalledTimes(1);
  });

  const abortable: Partial<DownloadPorts> = {
    fetchTo: (_url, _to, options) =>
      new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  };

  it('用户取消：不保存，清掉临时文件，提示已取消', async () => {
    const ports = fakePorts(abortable);
    const d = createDownloader(ports, android);
    const running = d.start({ media: photo, fileName: 'a.png', sensitive: false });
    await vi.waitFor(() => expect(ports.fetchTo).toHaveBeenCalled());
    d.cancel('p1');
    expect(await running).toEqual({ status: 'cancelled', quiet: false });
    expect(ports.saveToGallery).not.toHaveBeenCalled();
    expect(ports.removeTemp).toHaveBeenLastCalledWith('p1');
    expect(d.stateOf('p1')).toBeNull();
  });

  it('退出登录：全部停下，不再保存，也不打扰下一个人', async () => {
    const ports = fakePorts(abortable);
    const d = createDownloader(ports, android);
    const a = d.start({ media: photo, fileName: 'a.png', sensitive: false });
    const b = d.start({ media: pdf, fileName: 'b.pdf', sensitive: true });
    await vi.waitFor(() => expect(ports.fetchTo).toHaveBeenCalledTimes(2));
    d.cancelAll();
    expect(await a).toEqual({ status: 'cancelled', quiet: true });
    expect(await b).toEqual({ status: 'cancelled', quiet: true });
    expect(ports.saveToGallery).not.toHaveBeenCalled();
    expect(ports.saveToFolder).not.toHaveBeenCalled();
  });

  it('选位置时已经退出登录，就不再取链接', async () => {
    let pick: (uri: string | null) => void = () => {};
    const ports = fakePorts({
      pickFolder: () =>
        new Promise((resolve) => {
          pick = resolve;
        }),
    });
    const d = createDownloader(ports, android);
    const running = d.start({ media: pdf, fileName: 'a.pdf', sensitive: true });
    await vi.waitFor(() => expect(ports.pickFolder).toHaveBeenCalled());
    d.cancelAll();
    pick('content://folder');
    expect(await running).toEqual({ status: 'cancelled', quiet: true });
    expect(ports.signedUrl).not.toHaveBeenCalled();
  });

  it('iOS：录音和证件交给系统分享面板', async () => {
    const ports = fakePorts();
    const outcome = await createDownloader(ports, { platform: 'ios' }).start({
      media: pdf,
      fileName: 'a.pdf',
      sensitive: true,
    });
    expect(outcome).toEqual({ status: 'saved', target: 'share' });
    expect(ports.share).toHaveBeenCalledWith('file:///cache/downloads/d1/a.pdf', 'application/pdf');
    expect(ports.pickFolder).not.toHaveBeenCalled();
  });
});

describe('自带链接的下载（收到的反馈的附件）', () => {
  const attachment = { id: 'f1', kind: 'image', mime: 'image/jpeg', size: 100 } as const;

  it('用请求自带的链接，不找本地副本，也不问回忆的接口；敏感的不进相册', async () => {
    const ports = fakePorts({ findLocalCopy: async () => 'file:///uploads/f1-original' });
    const signedUrl = vi.fn(async () => 'https://storage.example/feedback-signed');
    const outcome = await createDownloader(ports, android).start({
      media: attachment,
      fileName: 'f1.jpg',
      sensitive: true,
      signedUrl,
    });
    expect(outcome).toEqual({ status: 'saved', target: 'folder' });
    expect(signedUrl).toHaveBeenCalledTimes(1);
    expect(ports.signedUrl).not.toHaveBeenCalled();
    expect(ports.findLocalCopy).not.toHaveBeenCalled();
    expect(ports.fetchTo.mock.calls[0]?.[0]).toBe('https://storage.example/feedback-signed');
    expect(ports.saveToGallery).not.toHaveBeenCalled();
  });

  it('服务端说附件已经删除时如实说，不说成网络问题', async () => {
    const ports = fakePorts();
    const outcome = await createDownloader(ports, android).start({
      media: attachment,
      fileName: 'f1.jpg',
      sensitive: true,
      signedUrl: async () => {
        throw new DownloadGone();
      },
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'gone' });
    expect(downloadMessage(outcome)).toBe('这个文件已经删除了');
    expect(ports.fetchTo).not.toHaveBeenCalled();
  });
});
