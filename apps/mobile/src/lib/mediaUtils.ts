/** 不依赖 React Native 的纯函数，方便单元测试。 */

export function pickDurationMs(duration: number | null | undefined): number | undefined {
  return duration && duration > 0 ? Math.round(duration) : undefined;
}

/** 把录音时采到的电平压缩成固定数量的波形点。分贝值转成 0–1。 */
export function downsamplePeaks(samplesDb: readonly number[], count = 40): number[] {
  if (samplesDb.length === 0) return [];
  const normalized = samplesDb.map((db) => Math.min(1, Math.max(0, (db + 60) / 60)));
  const out: number[] = [];
  const size = normalized.length / count;
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * size);
    const to = Math.max(from + 1, Math.floor((i + 1) * size));
    const slice = normalized.slice(from, to);
    if (slice.length === 0) break;
    out.push(Math.round(Math.max(...slice) * 100) / 100);
  }
  return out;
}

/** 没有真实波形时（比如旧数据）按 id 生成稳定的装饰波形，不要随机，否则每次渲染都变。 */
export function fallbackPeaks(seed: string, count = 28): number[] {
  let x = 0;
  for (let i = 0; i < seed.length; i++) x = (x * 31 + seed.charCodeAt(i)) % 233280;
  return Array.from({ length: count }, () => {
    x = (x * 9301 + 49297) % 233280;
    return 0.2 + (x / 233280) * 0.8;
  });
}

export interface CachedUrl {
  url: string;
  expiresAt: number;
}

/** 链接快过期就当作无效，避免图片加载到一半 403。 */
export function isUrlFresh(
  entry: CachedUrl | undefined,
  now: number,
  marginMs = 60_000,
): entry is CachedUrl {
  return Boolean(entry && entry.expiresAt - marginMs > now);
}

/** 拿不到链接时隔多久再试一次。failures 是已经连续失败的次数。 */
export function mediaRetryDelayMs(failures: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, failures));
}

/** 全局同一时间只放一段录音：新的开始时，暂停正在放的那段。 */
export function createExclusivePlayback<P extends { pause(): void }>() {
  let current: P | null = null;
  return {
    claim(player: P) {
      if (current && current !== player) {
        try {
          current.pause();
        } catch {
          // 播放器可能已经被释放，这时本来也不会出声。
        }
      }
      current = player;
    },
    release(player: P) {
      if (current === player) current = null;
    },
  };
}

/** 证件卡片上的小标记：优先用扩展名（PDF、JPG），没有就看 MIME。 */
export function fileBadge(file: { name?: string; mime?: string; kind: string }): string {
  const fromName = file.name?.includes('.') ? file.name.split('.').pop() : undefined;
  const raw = fromName || file.mime?.split('/').pop() || '';
  const upper = raw.toUpperCase();
  if (upper === 'JPEG') return 'JPG';
  if (/^[A-Z0-9]{1,5}$/.test(upper)) return upper;
  return file.kind === 'pdf' ? 'PDF' : 'IMG';
}

const escapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 成长册 HTML 里的用户内容必须转义，否则 `<` 会让排版错乱。 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => escapes[c] ?? c);
}
