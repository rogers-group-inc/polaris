/**
 * tests/unit/assistantConversationImages.test.ts
 *
 * Screenshot uploads on an assistant turn (business rule 95(l)): the type is
 * sniffed from the bytes, never taken from the upload.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn() }));

import { sniffImageType, IMAGE_LIMITS } from "../../src/services/assistantConversationService.js";

describe("sniffImageType", () => {
  it("recognises PNG, JPEG, WebP and GIF by their leading bytes", () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
    expect(sniffImageType(Buffer.from("GIF89a...."))).toBe("image/gif");
  });

  it("refuses anything else, however it is named", () => {
    expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(Buffer.from("<html><script>"))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it("caps a message at 4 images of 3.5 MiB", () => {
    expect(IMAGE_LIMITS).toEqual({ perMessage: 4, maxBytes: 3.5 * 1024 * 1024 });
  });
});
