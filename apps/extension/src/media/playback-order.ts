export function visiblePlaybackArea(
  rect: DOMRectReadOnly,
  viewport = { width: innerWidth, height: innerHeight },
): number {
  const width = Math.min(viewport.width, rect.right) - Math.max(0, rect.left);
  const height = Math.min(viewport.height, rect.bottom) - Math.max(0, rect.top);
  return Math.max(0, width) * Math.max(0, height);
}
