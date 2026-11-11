/**
 * src/utils/imageDimensions.ts — read an image's pixel size from its header.
 *
 * For the Device Map's uploaded topology backgrounds (PNG / JPEG / WebP, the
 * set detectImageMagic accepts). Parses only the header bytes; never decodes
 * the image. Returns null when the header is truncated or malformed, which the
 * caller reports as an unreadable image.
 */

import type { ImageExt } from "./imageMagic.js";

export interface ImageSize {
  width: number;
  height: number;
}

function png(buf: Buffer): ImageSize | null {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4).
  if (buf.length < 24 || buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Start-of-frame markers carrying the frame size (C4 / C8 / CC are not frames).
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(buf: Buffer): ImageSize | null {
  let i = 2; // past FFD8
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (JPEG_SOF.has(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webp(buf: Buffer): ImageSize | null {
  if (buf.length < 30) return null;
  const chunk = buf.subarray(12, 16).toString("ascii");
  if (chunk === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X") {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

/** Pixel size of a PNG / JPEG / WebP buffer, or null when the header cannot be read. */
export function readImageSize(buf: Buffer, ext: ImageExt): ImageSize | null {
  try {
    const size = ext === ".png" ? png(buf) : ext === ".jpg" ? jpeg(buf) : webp(buf);
    if (!size || size.width <= 0 || size.height <= 0) return null;
    return size;
  } catch {
    return null;
  }
}
