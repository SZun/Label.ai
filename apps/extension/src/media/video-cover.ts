// A feed often leaves its cover image mounted behind the playing video.
// Only suppress the image when playback covers the majority of its visible centerline.
export function playingVideoCovers(
  image: Element,
  rect: DOMRectReadOnly,
  stackAt = document.elementsFromPoint?.bind(document),
): boolean {
  if (!stackAt) return false;
  const left = Math.max(0, rect.left),
    right = Math.min(innerWidth, rect.right);
  const top = Math.max(0, rect.top),
    bottom = Math.min(innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return false;
  let covered = 0;
  for (const fraction of [0.25, 0.5, 0.75]) {
    const stack = stackAt(left + (right - left) * fraction, (top + bottom) / 2);
    for (const item of stack) {
      if (item === image) break;
      if (item instanceof HTMLVideoElement && !item.paused && !item.ended) {
        covered++;
        break;
      }
    }
  }
  return covered >= 2;
}
