import type { FramePayload } from '../core/protocol';
import { captureVideoFrame, createVideoSceneReader } from './capture';
import { MAX_SAMPLED_DURATION_MS } from './video-sampling';

export const PLAYBACK_WINDOW_MS = 4000;
const SAMPLE_INTERVAL_MS = 440;
const SCENE_INTERVAL_MS = 240;
const MAX_PRESENTATION_GAP_MS = 650;

export function needsPlaybackWindow(durationMs: number, currentMs: number, source: string) {
  if (durationMs === Infinity || durationMs > MAX_SAMPLED_DURATION_MS) return true;
  // Buffer-backed players are frequently recycled by feeds. A viewer shouldn't
  // need to stay until the end of a 45-second Short before its first analysis.
  if (durationMs >= 10_000 && (source.startsWith('blob:') || source.startsWith('media-source:')))
    return true;
  // A whole-clip sample cannot recover an opening third the viewer missed.
  return currentMs > durationMs * 0.2 && durationMs - currentMs >= PLAYBACK_WINDOW_MS;
}

function colorDifference(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let difference = 0;
  for (let i = 0; i < a.length; i += 4)
    difference +=
      Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
  return difference / ((a.length / 4) * 3 * 255);
}

export type PlaybackSample = {
  scope: 'playback-window';
  kind: 'video';
  durationMs: number;
  coverage: number;
  frames: FramePayload[];
};

// Only presented frames may start a window. Keep watching the same scene while
// the worker scores it and while its badge is visible. No player seek or fetch.
export function observePlaybackWindow(
  video: HTMLVideoElement,
  current: () => boolean,
  ready: (sample: PlaybackSample) => void,
  invalid: (unreadable: boolean) => void,
  renewal: { pending: () => boolean; setSceneConfirmed: (confirmed: boolean) => void },
) {
  const readScene = createVideoSceneReader(video);
  let previousGrid: Uint8ClampedArray | undefined;
  let referenceGrid: Uint8ClampedArray | undefined;
  let previousTime = -1;
  let sceneTime = -Infinity;
  let start: number | undefined;
  let lastSample = -Infinity;
  let frames: FramePayload[] | undefined = [];
  let callback: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (callback !== undefined) video.cancelVideoFrameCallback(callback);
    if (timeout !== undefined) clearTimeout(timeout);
    frames = undefined;
    referenceGrid = previousGrid = undefined;
  };
  const retire = (unreadable = false) => {
    stop();
    invalid(unreadable);
  };
  const armTimeout = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = setTimeout(retire, 3000);
  };
  const presented: VideoFrameRequestCallback = (_now, { mediaTime }) => {
    callback = undefined;
    const time = mediaTime * 1000;
    if (stopped) return;
    if (
      video.paused ||
      video.seeking ||
      video.ended ||
      !Number.isFinite(time) ||
      time < 0 ||
      (previousTime >= 0 && (time < previousTime || time - previousTime > MAX_PRESENTATION_GAP_MS))
    )
      return retire();
    start ??= time;
    previousTime = time;
    const elapsed = time - start;
    if (elapsed > 32_000) return retire();
    try {
      const needsFrame =
        frames !== undefined &&
        (elapsed - lastSample >= SAMPLE_INTERVAL_MS || elapsed >= PLAYBACK_WINDOW_MS);
      const needsGrid =
        time - sceneTime >= SCENE_INTERVAL_MS ||
        (frames !== undefined && elapsed >= PLAYBACK_WINDOW_MS);
      if ((needsFrame || needsGrid) && !current()) {
        // A busy WASM worker can finish a submitted window before it answers
        // a renewal. Observe only playback time until a fresh grant arrives.
        if (frames !== undefined || !renewal.pending()) return retire();
        renewal.setSceneConfirmed(false);
        sceneTime = time;
        armTimeout();
        callback = video.requestVideoFrameCallback(presented);
        return;
      }
      if (needsGrid) {
        const grid = readScene();
        if (
          (previousGrid && colorDifference(previousGrid, grid) > 0.2) ||
          (referenceGrid && colorDifference(referenceGrid, grid) > 0.18)
        )
          return retire();
        previousGrid = grid;
        renewal.setSceneConfirmed(true);
        sceneTime = time;
        armTimeout();
      }
      if (frames && needsFrame) {
        frames.push(captureVideoFrame(video, elapsed, 384));
        lastSample = elapsed;
        if (elapsed >= PLAYBACK_WINDOW_MS) {
          if (elapsed > 4500 || frames.length < 8) return retire();
          referenceGrid = previousGrid;
          const captured = frames;
          frames = undefined;
          ready({
            kind: 'video',
            scope: 'playback-window',
            frames: captured,
            durationMs: elapsed,
            coverage: 1,
          });
        }
      }
    } catch {
      return retire(true);
    }
    if (!stopped) callback = video.requestVideoFrameCallback(presented);
  };
  armTimeout();
  callback = video.requestVideoFrameCallback(presented);
  return stop;
}
