/**
 * tests/unit/imageUpdateCheck.test.ts — updateService.ts → checkImageForUpdates,
 * the container install's update check, and updateCheckIntervalMs.
 *
 * A container has no .git tree, so "is there a newer Polaris?" compares this
 * image's POLARIS_BUILD_COMMIT_COUNT with the published tag's (read through
 * utils/imageRegistry.ts, mocked here). Pinned: newer → "available" with the
 * gap; same or older → "up-to-date"; a registry failure or an image with no
 * count → "disabled" with a note, never "failed" (the card reads "failed" as
 * a failed update). Every result says updateMethod "image".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ fetchImageBuildInfo: vi.fn() }));

vi.mock("../../src/db.js", () => ({ prisma: { setting: { findUnique: vi.fn(), upsert: vi.fn() } } }));
vi.mock("../../src/utils/imageRegistry.js", () => ({ fetchImageBuildInfo: h.fetchImageBuildInfo }));

import { checkImageForUpdates, updateCheckIntervalMs, DEFAULT_UPDATE_IMAGE } from "../../src/services/updateService.js";

const saved = { count: process.env.POLARIS_BUILD_COMMIT_COUNT, image: process.env.POLARIS_UPDATE_IMAGE };

beforeEach(() => {
  h.fetchImageBuildInfo.mockReset();
  process.env.POLARIS_BUILD_COMMIT_COUNT = "3951";
  delete process.env.POLARIS_UPDATE_IMAGE;
});

afterEach(() => {
  if (saved.count === undefined) delete process.env.POLARIS_BUILD_COMMIT_COUNT;
  else process.env.POLARIS_BUILD_COMMIT_COUNT = saved.count;
  if (saved.image === undefined) delete process.env.POLARIS_UPDATE_IMAGE;
  else process.env.POLARIS_UPDATE_IMAGE = saved.image;
});

describe("checkImageForUpdates", () => {
  it("reports available with the gap when the published build is newer", async () => {
    h.fetchImageBuildInfo.mockResolvedValue({
      commitCount: 3962, revision: "43f9a1cac6a2bf6d", source: "https://github.com/rogers-group-inc/polaris", created: null,
    });
    const s = await checkImageForUpdates();
    expect(h.fetchImageBuildInfo).toHaveBeenCalledWith(DEFAULT_UPDATE_IMAGE, undefined);
    expect(s.state).toBe("available");
    expect(s.updateMethod).toBe("image");
    expect(s.commitsBehind).toBe(11);
    expect(s.latestVersion).toMatch(/\.3962$/);
    expect(s.latestCommit).toBe("43f9a1c");
    expect(s.source).toBe("https://github.com/rogers-group-inc/polaris");
    expect(s.checkedAt).toBeTruthy();
  });

  it("reports up-to-date when the published build is the same or older", async () => {
    h.fetchImageBuildInfo.mockResolvedValue({ commitCount: 3951, revision: null, source: null, created: null });
    expect((await checkImageForUpdates()).state).toBe("up-to-date");
    h.fetchImageBuildInfo.mockResolvedValue({ commitCount: 3900, revision: null, source: null, created: null });
    const older = await checkImageForUpdates();
    expect(older.state).toBe("up-to-date");
    expect(older.commitsBehind).toBe(0);
  });

  it("checks POLARIS_UPDATE_IMAGE when it is set", async () => {
    process.env.POLARIS_UPDATE_IMAGE = "mirror.local:5000/polaris:latest";
    h.fetchImageBuildInfo.mockResolvedValue({ commitCount: 3951, revision: null, source: null, created: null });
    const s = await checkImageForUpdates();
    expect(h.fetchImageBuildInfo).toHaveBeenCalledWith("mirror.local:5000/polaris:latest", undefined);
    expect(s.image).toBe("mirror.local:5000/polaris:latest");
  });

  it("does not link a source that is not a GitHub https URL", async () => {
    h.fetchImageBuildInfo.mockResolvedValue({ commitCount: 3962, revision: "abc", source: "javascript:alert(1)", created: null });
    expect((await checkImageForUpdates()).source).toBeUndefined();
  });

  it("reports a registry failure as disabled with a note, never failed", async () => {
    h.fetchImageBuildInfo.mockRejectedValue(new Error("ghcr.io answered 503"));
    const s = await checkImageForUpdates();
    expect(s.state).toBe("disabled");
    expect(s.updateMethod).toBe("image");
    expect(s.note).toMatch(/503/);
  });

  it("does not compare when this image has no commit count", async () => {
    process.env.POLARIS_BUILD_COMMIT_COUNT = "0";
    const s = await checkImageForUpdates();
    expect(h.fetchImageBuildInfo).not.toHaveBeenCalled();
    expect(s.state).toBe("disabled");
    expect(s.note).toMatch(/without a commit count/);
  });

  it("does not compare when the published image has no commit count", async () => {
    h.fetchImageBuildInfo.mockResolvedValue({ commitCount: null, revision: null, source: null, created: null });
    const s = await checkImageForUpdates();
    expect(s.state).toBe("disabled");
    expect(s.note).toMatch(/doesn't say which build/);
  });
});

describe("updateCheckIntervalMs", () => {
  it("is weekly outside a container (this test host has a .git tree)", () => {
    expect(updateCheckIntervalMs()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
