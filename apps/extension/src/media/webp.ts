type Size = { width: number; height: number };

/** Read dimensions from a single static bitstream before handing it to a decoder. */
export function staticWebpDimensions(bytes: Uint8Array): Size | undefined {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 20 ||
    data.getUint32(0) !== 0x52494646 || // RIFF
    data.getUint32(4, true) + 8 !== bytes.length ||
    data.getUint32(8) !== 0x57454250
  )
    return; // WEBP
  let image: Size | undefined;
  let canvas: Size | undefined;
  for (let pos = 12; pos < bytes.length; ) {
    if (pos + 8 > bytes.length) return;
    const tag = data.getUint32(pos);
    const length = data.getUint32(pos + 4, true);
    const start = pos + 8;
    pos = start + length + (length % 2);
    if (pos > bytes.length || tag === 0x414e494d || tag === 0x414e4d46) return; // ANIM, ANMF
    if (tag === 0x56503858) {
      // VP8X canvas
      if (start !== 20 || length !== 10 || bytes[start] & 2) return;
      const uint24 = (i: number) => bytes[i] + 256 * bytes[i + 1] + 65536 * bytes[i + 2];
      canvas = { width: uint24(start + 4) + 1, height: uint24(start + 7) + 1 };
    } else if (tag === 0x56503820) {
      // VP8 lossy key frame
      if (
        image ||
        length < 10 ||
        bytes[start] & 1 ||
        bytes[start + 3] !== 0x9d ||
        bytes[start + 4] !== 1 ||
        bytes[start + 5] !== 0x2a
      )
        return;
      image = {
        width: data.getUint16(start + 6, true) & 0x3fff,
        height: data.getUint16(start + 8, true) & 0x3fff,
      };
    } else if (tag === 0x5650384c) {
      // VP8L lossless
      if (image || length < 5 || bytes[start] !== 0x2f) return;
      const bits = data.getUint32(start + 1, true);
      if (bits >>> 29) return;
      image = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if (canvas && (canvas.width !== image?.width || canvas.height !== image?.height)) return;
  return image;
}
