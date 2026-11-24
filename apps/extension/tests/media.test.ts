import { expect, it } from 'vitest';
import { boundedDimensions, embeddedOriginal, contentAddressedSource } from '../src/core/media';

it('ACQ-04 preserves aspect ratio and bounds local pixel acquisition', () => {
  expect(boundedDimensions(2000, 1000)).toEqual({ width: 1024, height: 512 });
  expect(boundedDimensions(600, 900)).toEqual({ width: 600, height: 900 });
  expect(boundedDimensions(0, 10)).toBeNull();
  expect(boundedDimensions(10000, 10000)).toBeNull();
});

it('only accepts exact same-origin hash-addressed public media with no query', () => {
  const sha = 'a'.repeat(64);
  expect(contentAddressedSource(`https://news.example/assets/${sha}.jpg`, 'https://news.example/story')).toEqual({ url: `https://news.example/assets/${sha}.jpg`, sha256: sha, mime: 'image/jpeg' });
  expect(contentAddressedSource(`https://other.example/assets/${sha}.jpg`, 'https://news.example/story')).toBeNull();
  expect(contentAddressedSource(`https://news.example/assets/${sha}.jpg?token=secret`, 'https://news.example/story')).toBeNull();
  expect(contentAddressedSource('https://news.example/assets/file.jpg', 'https://news.example/story')).toBeNull();
});
it('ACQ-02 obtains original bytes only from the actual embedded source', () => {
  expect(embeddedOriginal('data:image/jpeg;base64,AQID')).toEqual({ mime: 'image/jpeg', base64: 'AQID' });
  expect(embeddedOriginal('https://example.org/image.jpg')).toBeUndefined();
  expect(embeddedOriginal('data:image/svg+xml;base64,AQID')).toBeUndefined();
  expect(embeddedOriginal('data:image/jpeg;base64,%%%')).toBeUndefined();
});
