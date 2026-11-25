import { expect, it } from 'vitest';
import { embeddedVideoOriginal } from '../src/media/video-original';
import { MAX_ORIGINAL_BYTES } from '../src/core/protocol';
const mp4 = 'data:video/mp4;base64,' + btoa('\0\0\0\x10ftypisom\0\0\0\0');
function video(currentSrc: string, srcObject: unknown = null) {
  return {
    currentSrc,
    srcObject,
    mediaKeys: null,
    isConnected: true,
    readyState: 2,
  } as HTMLVideoElement;
}
it('returns exact original bytes of a loaded embedded MP4', () => {
  expect(embeddedVideoOriginal(video(mp4), mp4)).toEqual({
    mime: 'video/mp4',
    base64: mp4.split(',')[1],
  });
});
it('skips replaced, streamed, protected, oversized, remote or mislabeled data', () => {
  expect(embeddedVideoOriginal(video('blob:https://a.example/id'), mp4)).toBeUndefined();
  expect(embeddedVideoOriginal(video(mp4, {}), mp4)).toBeUndefined();
  expect(
    embeddedVideoOriginal({ ...video(mp4), mediaKeys: {} } as HTMLVideoElement, mp4),
  ).toBeUndefined();
  for (const source of [
    'https://cdn.example/video.mp4',
    'data:video/mp4;base64,' + btoa('not a video file'),
    'data:video/mp4;base64,' + 'A'.repeat(Math.ceil(MAX_ORIGINAL_BYTES / 3) * 4 + 4),
  ]) {
    expect(embeddedVideoOriginal(video(source), source)).toBeUndefined();
  }
});
