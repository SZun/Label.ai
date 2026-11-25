import { afterEach, expect, it, vi } from 'vitest';
import { badgeBounds, hasImageBadgeSpace } from '../src/core/label-bounds';

function rect(element: Element, x: number, y: number, width: number, height: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, width, height));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([15, 440, 815])('fits the same 128px thumbnail at viewport x=%d', (x) => {
  const image = document.body.appendChild(document.createElement('img'));
  rect(image, x, 50, 128, 140);
  expect(badgeBounds(image)).toEqual({ x: x + 8, y: 58, width: 112, compact: true });
});

it('allows horizontal overflow when only the vertical axis is clipped', () => {
  const row = document.body.appendChild(document.createElement('div'));
  row.style.overflowX = 'visible';
  row.style.overflowY = 'clip';
  rect(row, 10, 40, 180, 160);
  const image = row.appendChild(document.createElement('img'));
  rect(image, 600, 15, 220, 200);
  expect(badgeBounds(image)).toEqual({ x: 608, y: 48, width: 204, compact: false });
});

it('bounds a badge to the intersection of a shadow-host scroller and the viewport', () => {
  const host = document.body.appendChild(document.createElement('section'));
  host.style.overflow = 'hidden';
  rect(host, 740, 10, 140, 300);
  const image = host.attachShadow({ mode: 'open' }).appendChild(document.createElement('img'));
  rect(image, 690, -10, 250, 220);
  expect(badgeBounds(image)).toEqual({ x: 748, y: 18, width: 124, compact: true });
  rect(host, 740, 265, 140, 300);
  expect(badgeBounds(image)).toBeNull();
});

it('admits compact feed thumbnails only when the complete badge can fit', () => {
  expect(hasImageBadgeSpace(120, 68)).toBe(true);
  expect(hasImageBadgeSpace(112, 52)).toBe(true);
  expect(hasImageBadgeSpace(111, 120)).toBe(false);
  expect(hasImageBadgeSpace(128, 51)).toBe(false);
  expect(hasImageBadgeSpace(250, 43)).toBe(false);
});
