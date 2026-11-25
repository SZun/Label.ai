function layoutParent(element: Element): Element | null {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

const clips = /^(hidden|clip|scroll|auto|overlay)$/;

export function badgeBounds(element: Element) {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(innerWidth, rect.right);
  let bottom = Math.min(innerHeight, rect.bottom);

  for (
    let ancestor = layoutParent(element);
    ancestor && ancestor !== document.documentElement;
    ancestor = layoutParent(ancestor)
  ) {
    const style = getComputedStyle(ancestor);
    const clipX = clips.test(style.overflowX || style.overflow);
    const clipY = clips.test(style.overflowY || style.overflow);
    if (!clipX && !clipY) continue;
    const clip = ancestor.getBoundingClientRect();
    if (clipX) {
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (clipY) {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
  }

  const visibleWidth = right - left;
  const compact = visibleWidth < 182;
  // Compact badges can wrap. Keep room for two lines and a margin on every side.
  if (visibleWidth < 112 || bottom - top < (compact ? 52 : 44)) return null;
  return { x: left + 8, y: top + 8, width: visibleWidth - 16, compact };
}
