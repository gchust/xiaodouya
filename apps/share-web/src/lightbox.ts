import { type PublicMedia, t } from '@xiaodouya/shared';
import { safeMediaUrl } from './media';

const SWIPE_PX = 50;

function button(className: string, label: string, symbol: string, onPress: () => void) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = symbol;
  node.setAttribute('aria-label', label);
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    onPress();
  });
  return node;
}

/**
 * 点图片放大。先显示已经加载的缩略图，原图到了再换上；原图打不开（比如浏览器不支持的 HEIC，
 * 或者链接过期）就留在缩略图，不会变成一片空白。不拦截捏合，放大交给浏览器。
 */
export function openLightbox(
  items: PublicMedia[],
  start: number,
  allowLocalHttp: boolean,
): () => void {
  let index = start;
  const opener = document.activeElement as HTMLElement | null;
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const img = document.createElement('img');
  img.className = 'lightbox-image';
  img.alt = '';
  const counter = document.createElement('span');
  counter.className = 'lightbox-counter';
  const problem = document.createElement('p');
  problem.className = 'lightbox-problem';
  problem.textContent = t().share.mediaFailed;
  problem.hidden = true;
  img.addEventListener('error', () => {
    img.hidden = true;
    problem.hidden = false;
  });
  img.addEventListener('load', () => {
    img.hidden = false;
    problem.hidden = true;
  });

  const show = () => {
    const item = items[index];
    if (!item) return;
    counter.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
    const thumb = safeMediaUrl(item.thumbUrl, allowLocalHttp);
    const original = safeMediaUrl(item.url, allowLocalHttp);
    const first = thumb ?? original;
    if (first) img.setAttribute('src', first);
    if (original && thumb) {
      const shownFor = index;
      const loader = new Image();
      loader.addEventListener('load', () => {
        if (shownFor === index) img.setAttribute('src', original);
      });
      loader.src = original;
    }
  };

  const move = (delta: number) => {
    index = (index + delta + items.length) % items.length;
    show();
  };

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('no-scroll');
    opener?.focus?.();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowLeft' && items.length > 1) move(-1);
    else if (event.key === 'ArrowRight' && items.length > 1) move(1);
  };

  const closeButton = button('lightbox-close', t().share.closePhoto, '×', close);
  overlay.append(img, problem, closeButton, counter);
  if (items.length > 1) {
    overlay.append(
      button('lightbox-nav lightbox-prev', t().share.previousPhoto, '‹', () => move(-1)),
      button('lightbox-nav lightbox-next', t().share.nextPhoto, '›', () => move(1)),
    );
  }
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  let touchX: number | null = null;
  overlay.addEventListener('touchstart', (event) => {
    touchX = event.touches.length === 1 ? (event.touches[0]?.clientX ?? null) : null;
  });
  overlay.addEventListener('touchend', (event) => {
    const end = event.changedTouches[0]?.clientX;
    if (touchX === null || end === undefined || items.length < 2) return;
    // 放大看图时拖动是在移动画面，不是翻页。
    if ((window.visualViewport?.scale ?? 1) > 1.01) return;
    const delta = end - touchX;
    if (Math.abs(delta) > SWIPE_PX) move(delta < 0 ? 1 : -1);
    touchX = null;
  });

  document.addEventListener('keydown', onKey);
  document.documentElement.classList.add('no-scroll');
  document.body.append(overlay);
  show();
  closeButton.focus();
  return close;
}
