import type { GalleryState } from './gallery-diagnostics';

export const statusText = {
  searching: 'Checking the active tab…',
  unavailable: 'The scanner is unavailable in this tab. Check site access and refresh the page.',
  inactive: 'Scanning is paused or this page is excluded.',
  missing:
    'No visible video player was found in the main page. An embedded player may be in another frame.',
  'hidden-player':
    'The page is hiding its video element. Use the site’s play control. Some players display their video on a separate surface.',
  protected: 'The player is using protected playback.',
  play: 'Press play and keep the player visible to sample moving frames.',
  collecting: 'Waiting for enough readable playback frames.',
  analyzing: 'The local detector is analyzing the video.',
  labeled: 'The detector flagged this video.',
  'below-threshold': 'The detector analyzed the video and found insufficient evidence for a badge.',
  unreadable: 'The player or its frames could not be analyzed.',
  failed: 'Analysis was interrupted or failed.',
} as const;
export type PlayerStatus = keyof typeof statusText;

export function playerStatus(
  video: HTMLVideoElement,
  state: GalleryState | undefined,
  inFlight: boolean,
  visible = true,
): PlayerStatus {
  if (!visible) return 'hidden-player';
  if (video.mediaKeys) return 'protected';
  if (inFlight) return 'analyzing';
  switch (state) {
    case 'labeled':
      return 'labeled';
    case 'completed-no-label':
      return 'below-threshold';
    case 'unsupported':
      return 'unreadable';
    case 'failed':
      return 'failed';
  }
  return video.paused || video.ended ? 'play' : 'collecting';
}
