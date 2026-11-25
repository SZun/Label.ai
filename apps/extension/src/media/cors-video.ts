import { MAX_COMPARE_PIXELS } from '../cached-original';
import type { FramePayload } from '../core/protocol';
import { captureVideoFrame } from './capture';
import { eligiblePublicMediaUrl, readPublicMedia } from './public-media';
import { videoSamplePlan } from './video-sampling';

const MAX_CLIP_BYTES = 16 * 1024 * 1024;

export function canReadCorsVideo(video: HTMLVideoElement, source: string) {
  return (
    video.isConnected &&
    // A natural loop can briefly buffer after all target frames were observed.
    video.readyState >= 1 &&
    video.currentSrc === source &&
    !video.srcObject &&
    !video.mediaKeys &&
    video.crossOrigin !== 'use-credentials' &&
    video.videoWidth > 0 &&
    video.videoHeight > 0 &&
    video.videoWidth * video.videoHeight <= MAX_COMPARE_PIXELS &&
    Boolean(videoSamplePlan(video.duration * 1000)) &&
    eligiblePublicMediaUrl(source) &&
    new URL(source).origin !== location.origin
  );
}

function matchesContainer(bytes: Uint8Array, mime: string) {
  if (mime === 'video/webm')
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    );
  if (
    bytes.length < 16 ||
    bytes[4] !== 0x66 ||
    bytes[5] !== 0x74 ||
    bytes[6] !== 0x79 ||
    bytes[7] !== 0x70
  )
    return false;
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  return length >= 16 && length <= bytes.length;
}

// Install listeners before assigning a blob source or seeking. Never play or attach this decoder.
function mediaEvent(
  decoder: HTMLVideoElement,
  event: string,
  signal: AbortSignal,
  action: () => void,
) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('Local video decode interrupted'));
    };
    const cleanup = () => {
      decoder.removeEventListener(event, done);
      decoder.removeEventListener('error', fail);
      signal.removeEventListener('abort', fail);
    };
    decoder.addEventListener(event, done, { once: true });
    decoder.addEventListener('error', fail, { once: true });
    signal.addEventListener('abort', fail, { once: true });
    try {
      action();
    } catch {
      fail();
    }
  });
}

/** Read only timestamps the visible player actually presented. Bytes from a
 * second GET can supply a visual estimate, never a verified original. */
export async function readCorsVideoFrames(
  video: HTMLVideoElement,
  source: string,
  observedTimesMs: readonly number[],
  signal: AbortSignal,
): Promise<FramePayload[] | undefined> {
  const { videoWidth: width, videoHeight: height, duration } = video;
  const plan = videoSamplePlan(duration * 1000);
  if (
    !plan ||
    observedTimesMs.length < 3 ||
    observedTimesMs.length > plan.frameLimit ||
    observedTimesMs.some(
      (ms, i) =>
        !Number.isFinite(ms) ||
        ms < 0 ||
        ms >= duration * 1000 ||
        (i > 0 && ms <= observedTimesMs[i - 1]),
    ) ||
    signal.aborted ||
    !canReadCorsVideo(video, source)
  )
    return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 15_000);
  const current = () =>
    !controller.signal.aborted &&
    canReadCorsVideo(video, source) &&
    video.duration === duration &&
    video.videoWidth === width &&
    video.videoHeight === height;
  let decoder: HTMLVideoElement | undefined;
  let url: string | undefined;
  try {
    const file = await readPublicMedia(source, controller.signal, current, {
      allowedTypes: ['video/mp4', 'video/webm'],
      maxBytes: MAX_CLIP_BYTES,
      requireWholeFile: true,
    });
    if (!file || !current() || !matchesContainer(file.bytes, file.mime)) return;
    const local = document.createElement('video');
    decoder = local;
    local.preload = 'metadata';
    local.muted = true;
    local.playsInline = true;
    const blobUrl = URL.createObjectURL(new Blob([file.bytes], { type: file.mime }));
    url = blobUrl;
    await mediaEvent(local, 'loadedmetadata', controller.signal, () => {
      local.src = blobUrl;
    });
    const sameClip = () =>
      current() &&
      !local.mediaKeys &&
      local.paused &&
      local.videoWidth === width &&
      local.videoHeight === height &&
      Number.isFinite(local.duration) &&
      Math.abs(local.duration - duration) <= 0.001;
    const frames: FramePayload[] = [];
    for (const ms of observedTimesMs) {
      if (!sameClip()) return;
      const seconds = ms / 1000;
      if (local.readyState < 2 || local.currentTime !== seconds)
        await mediaEvent(local, 'seeked', controller.signal, () => {
          local.currentTime = seconds;
        });
      if (!sameClip() || local.readyState < 2 || Math.abs(local.currentTime - seconds) > 0.001)
        return;
      frames.push(captureVideoFrame(local, ms, plan.maxSide));
    }
    return frames;
  } catch {
    return;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.abort();
    if (decoder) {
      decoder.removeAttribute('src');
      decoder.load();
    }
    if (url) URL.revokeObjectURL(url);
  }
}
