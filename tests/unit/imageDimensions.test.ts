/**
 * tests/unit/imageDimensions.test.ts
 *
 * Header-only pixel-size reader for uploaded topology backgrounds: PNG IHDR,
 * JPEG start-of-frame (after other segments), and the three WebP chunk kinds.
 */

import { describe, it, expect } from "vitest";
import { readImageSize } from "../../src/utils/imageDimensions.js";

function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function webpVp8(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

function webpVp8l(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8L", 12, "ascii");
  const w = width - 1, h = height - 1;
  const bits = (w & 0x3fff) | ((h & 0x3fff) << 14);
  b.writeUInt32LE(bits >>> 0, 21);
  return b;
}

describe("readImageSize", () => {
  it("reads PNG IHDR", () => {
    expect(readImageSize(pngHeader(6400, 4480), ".png")).toEqual({ width: 6400, height: 4480 });
  });

  it("reads a JPEG start-of-frame after an APP0 segment", () => {
    expect(readImageSize(jpegHeader(1920, 1080), ".jpg")).toEqual({ width: 1920, height: 1080 });
  });

  it("reads all three WebP chunk kinds", () => {
    expect(readImageSize(webpVp8x(5000, 3000), ".webp")).toEqual({ width: 5000, height: 3000 });
    expect(readImageSize(webpVp8(800, 600), ".webp")).toEqual({ width: 800, height: 600 });
    expect(readImageSize(webpVp8l(1234, 567), ".webp")).toEqual({ width: 1234, height: 567 });
  });

  it("returns null for a truncated or malformed header", () => {
    expect(readImageSize(pngHeader(10, 10).subarray(0, 20), ".png")).toBeNull();
    expect(readImageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00]), ".jpg")).toBeNull();
    expect(readImageSize(pngHeader(0, 10), ".png")).toBeNull();
  });
});
