import { decodeBase64, MAX_ORIGINAL_BYTES } from '../core/protocol';

// Only the loaded element's complete inline file is eligible. A poster or rendered frame
// cannot provide a credential for the timelines or tracks of its containing video.
export function embeddedVideoOriginal(video: HTMLVideoElement, source: string) {
  const prefix = 'data:video/mp4;base64,';
  if (
    !video.isConnected ||
    video.readyState < 1 ||
    video.mediaKeys ||
    video.srcObject ||
    source !== video.currentSrc ||
    !source.startsWith(prefix) ||
    source.length > prefix.length + Math.ceil(MAX_ORIGINAL_BYTES / 3) * 4
  )
    return;
  const base64 = source.slice(prefix.length);
  try {
    const bytes = decodeBase64(base64, MAX_ORIGINAL_BYTES);
    if (
      bytes.length < 16 ||
      bytes[4] !== 0x66 ||
      bytes[5] !== 0x74 ||
      bytes[6] !== 0x79 ||
      bytes[7] !== 0x70
    )
      return;
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    if (boxSize < 16 || boxSize > bytes.length) return;
    return { mime: 'video/mp4', base64 };
  } catch {
    return;
  }
}
