import { afterEach, expect, it, vi } from 'vitest';
import { playbackSurfaceFor } from '../src/media/playback-surface';

const rect = new DOMRect(60, 40, 180, 320);

function box(element: Element, value = rect) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(value);
}

function player() {
  const card = document.body.appendChild(document.createElement('article'));
  const decoder = card.appendChild(document.createElement('div'));
  const video = decoder.appendChild(document.createElement('video'));
  video.style.opacity = '0';
  Object.defineProperties(video, {
    videoWidth: { value: 360 },
    videoHeight: { value: 640 },
  });
  box(video);
  const canvas = card.appendChild(document.createElement('canvas'));
  canvas.width = 360;
  canvas.height = 640;
  box(canvas);
  const hits = vi.fn<() => Element[]>(() => [video, canvas, card]);
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: hits });
  return { card, video, canvas, hits };
}

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(document, 'elementsFromPoint');
  vi.restoreAllMocks();
});

it('uses the visible video directly and the matching canvas when its decoder is transparent', () => {
  const { video, canvas } = player();
  video.style.opacity = '1';
  expect(playbackSurfaceFor(video)).toBe(video);
  video.style.opacity = '0';
  expect(playbackSurfaceFor(video)).toBe(canvas);
});

it.each([
  'covered',
  'hidden',
  'different bounds',
  'wrong bitmap aspect',
  'detached',
  'offscreen',
  'second canvas',
  'second decoder',
  'different player',
] as const)('rejects %s canvas bindings', (kind) => {
  const { card, video, canvas, hits } = player();
  if (kind === 'covered')
    hits.mockReturnValue([card.appendChild(document.createElement('aside')), canvas]);
  if (kind === 'hidden') canvas.style.visibility = 'hidden';
  if (kind === 'different bounds') box(canvas, new DOMRect(270, 40, 180, 320));
  if (kind === 'wrong bitmap aspect') canvas.width = 900;
  if (kind === 'detached') canvas.remove();
  if (kind === 'offscreen') {
    for (const el of [video, canvas]) box(el, new DOMRect(5000, 2000, 180, 320));
  }
  if (kind === 'second canvas') box(card.appendChild(document.createElement('canvas')));
  if (kind === 'second decoder') box(card.appendChild(document.createElement('video')));
  if (kind === 'different player')
    document.body.appendChild(document.createElement('article')).append(canvas);
  expect(playbackSurfaceFor(video)).toBeUndefined();
});

it('rechecks the visible surface when a feed reuses a player', () => {
  const { video, canvas, hits } = player();
  expect(playbackSurfaceFor(video)).toBe(canvas);
  hits.mockReturnValue([document.body]);
  expect(playbackSurfaceFor(video)).toBeUndefined();
  canvas.remove();
  video.remove();
  expect(playbackSurfaceFor(video)).toBeUndefined();
});

it('abstains while a click-through poster covers the published canvas', () => {
  const { card, video } = player();
  const poster = card.appendChild(document.createElement('img'));
  poster.src = '/preview.jpg';
  poster.style.pointerEvents = 'none';
  box(poster);
  expect(playbackSurfaceFor(video)).toBeUndefined();
  poster.style.opacity = '0';
  expect(playbackSurfaceFor(video)).toBeInstanceOf(HTMLCanvasElement);
});

it('resolves a player canvas under an unpainted input layer and decoder wrapper', () => {
  const { card, video, canvas, hits } = player();
  video.style.opacity = '1';
  video.parentElement!.style.opacity = '0';
  const controls = card.appendChild(document.createElement('div'));
  controls.style.opacity = '0';
  const button = controls.appendChild(document.createElement('button'));
  hits.mockReturnValue([button, controls, video, video.parentElement!, canvas]);
  expect(playbackSurfaceFor(video)).toBe(canvas);
  controls.style.opacity = '1';
  expect(playbackSurfaceFor(video)).toBeUndefined();
});

it('uses the explicitly visible video inside a visibility-hidden wrapper', () => {
  const { video } = player();
  video.style.opacity = '1';
  video.parentElement!.style.visibility = 'hidden';
  video.style.visibility = 'visible';
  expect(playbackSurfaceFor(video)).toBe(video);
});
