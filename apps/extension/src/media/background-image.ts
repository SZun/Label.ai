import { hasImageBadgeSpace } from '../core/label-bounds';
import { eligiblePublicImageUrl } from './cors-image';

function alignment(position: string) {
  const keywords: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  if (Object.hasOwn(keywords, position)) return keywords[position];
  if (!/^\d+(?:\.\d+)?%$/.test(position)) return;
  const fraction = parseFloat(position) / 100;
  return fraction <= 1 ? fraction : undefined;
}

function position(style: CSSStyleDeclaration) {
  const [x, y = 'center', ...rest] = (style.backgroundPosition || '0% 0%').split(/\s+/);
  const left = alignment(x);
  const top = alignment(y);
  return rest.length || left === undefined || top === undefined ? undefined : { left, top };
}

export function backgroundImageSource(element: Element): string {
  const style = getComputedStyle(element);
  const background = style.backgroundImage;
  if (!background.startsWith('url(')) return '';
  // CSSOM resolves relative URLs. Reject composites, gradients and unselected candidates.
  const match = /^url\((?:"([^"\\]+)"|'([^'\\]+)'|([^\s'"()\\]+))\)$/.exec(background);
  const url = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!url || url.startsWith('data:image/')) return url ?? '';
  if (
    element === document.documentElement ||
    element === document.body ||
    !eligiblePublicImageUrl(url) ||
    !['', 'auto', 'auto auto', 'cover', 'contain', '100% 100%'].includes(style.backgroundSize) ||
    !['', 'border-box', 'padding-box'].includes(style.backgroundClip) ||
    /round|space/.test(style.backgroundRepeat) ||
    (style.backgroundOrigin && style.backgroundOrigin !== 'padding-box') ||
    (style.backgroundAttachment && style.backgroundAttachment !== 'scroll') ||
    !position(style) ||
    element.querySelector('img, picture, video, canvas, iframe, object, embed, [role="img"]')
  )
    return '';
  return url;
}

// CSS cards can change the pictured region without changing URL (responsive
// boxes, same-URL carousel positions). Bind a sampled result to that layout.
export function backgroundLayoutKey(element: Element, url: string) {
  if (
    element instanceof HTMLImageElement ||
    element instanceof HTMLVideoElement ||
    !url.startsWith('https:')
  )
    return;
  const style = getComputedStyle(element);
  return [
    element.clientWidth,
    element.clientHeight,
    style.backgroundSize,
    style.backgroundPosition,
    style.backgroundRepeat,
  ].join(' ');
}

export function backgroundCrop(element: Element, image: ImageBitmap) {
  const { clientWidth: boxWidth, clientHeight: boxHeight } = element;
  if (!boxWidth || !boxHeight) return;
  const style = getComputedStyle(element);
  const align = position(style);
  if (!align) return;
  const full = { x: 0, y: 0, width: image.width, height: image.height };
  if (style.backgroundSize === '100% 100%') return full;
  const scaleX = boxWidth / image.width;
  const scaleY = boxHeight / image.height;
  if (style.backgroundSize === 'cover') {
    // Crop the same portion the publisher paints in the card.
    const scale = Math.max(scaleX, scaleY);
    const width = boxWidth / scale;
    const height = boxHeight / scale;
    return {
      x: (image.width - width) * align.left,
      y: (image.height - height) * align.top,
      width,
      height,
    };
  }
  const scale = style.backgroundSize === 'contain' ? Math.min(scaleX, scaleY) : 1;
  const width = image.width * scale;
  const height = image.height * scale;
  if (Math.abs(width - boxWidth) < 1 && Math.abs(height - boxHeight) < 1) return full;
  // A smaller non-repeating photograph is fine. A repeating texture, clipped
  // sprite or tiny icon behind a large card cannot represent its subject.
  if (
    style.backgroundRepeat === 'no-repeat' &&
    hasImageBadgeSpace(width, height) &&
    width <= boxWidth + 1 &&
    height <= boxHeight + 1
  )
    return full;
}
