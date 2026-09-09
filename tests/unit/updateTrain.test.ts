/**
 * tests/unit/updateTrain.test.ts
 *
 * update.train Setting persistence: default to "nightly", read "release" only
 * on the exact stored value, tolerate a missing row / DB error, and normalize
 * unknown values to "nightly" on write. Prisma is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import { getUpdateTrain, setUpdateTrain, isSafeGitRef, isSafeRepoUrl } from "../../src/services/updateService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const findUnique = prisma.setting.findUnique as unknown as Mock;
const upsert = prisma.setting.upsert as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getUpdateTrain", () => {
  it("defaults to nightly when no row exists", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getUpdateTrain()).toBe("nightly");
  });

  it("returns release when the stored value is exactly \"release\"", async () => {
    findUnique.mockResolvedValue({ key: "update.train", value: "release" });
    expect(await getUpdateTrain()).toBe("release");
  });

  it("falls back to nightly for any non-release value", async () => {
    findUnique.mockResolvedValue({ key: "update.train", value: "stable" });
    expect(await getUpdateTrain()).toBe("nightly");
  });

  it("tolerates a DB error and returns nightly", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await getUpdateTrain()).toBe("nightly");
  });
});

describe("setUpdateTrain", () => {
  it("upserts the release value", async () => {
    upsert.mockResolvedValue({});
    await setUpdateTrain("release");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "update.train" },
        update: { value: "release" },
        create: { key: "update.train", value: "release" },
      }),
    );
  });

  it("normalizes an unknown train to nightly on write", async () => {
    upsert.mockResolvedValue({});
    // @ts-expect-error — exercising the runtime normalization guard
    await setUpdateTrain("bogus");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { value: "nightly" } }),
    );
  });
});

/**
 * updateService shells out through `exec`, and the refs it interpolates are
 * read OUT OF THE UPDATE REPOSITORY — which POLARIS_UPDATE_REPO can point at a
 * fork or mirror. Git's own check-ref-format allows `;`, `&`, `|`, `$`, a
 * backtick and both quotes in a ref name, so "git accepted it" is not the same
 * as "safe to interpolate".
 */
describe("isSafeGitRef", () => {
  it("accepts the branch and tag names that actually occur", () => {
    for (const ref of [
      "main", "master", "origin/HEAD", "origin/main",
      "v1.0.0", "v0.17.2", "1.2", "release/2026-09", "feature_x", "a.b-c/d",
    ]) {
      expect(isSafeGitRef(ref), ref).toBe(true);
    }
  });

  it("rejects every ref that would reach the shell as a command", () => {
    for (const ref of [
      "v1.0.0;id",
      "v1.0.0`id`",
      "v1.0.0$(id)",
      "v1.0.0 && id",
      "v1.0.0|id",
      'v1.0.0"',
      "v1.0.0'",
      "v1.0.0\nid",
      "v1.0.0 id",
      "$(id)",
      "-v1.0.0",     // leading dash would be read as an option, not a ref
      "",
    ]) {
      expect(isSafeGitRef(ref), ref).toBe(false);
    }
  });

  it("rejects `..`, which would also re-point the HEAD..<ref> range reads", () => {
    expect(isSafeGitRef("v1..0")).toBe(false);
    expect(isSafeGitRef("../../etc/passwd")).toBe(false);
  });

  it("bounds the length", () => {
    expect(isSafeGitRef("v" + "1".repeat(500))).toBe(false);
  });
});

describe("isSafeRepoUrl", () => {
  it("accepts the clone-URL forms an operator would set", () => {
    for (const url of [
      "https://github.com/rogers-group-inc/polaris.git",
      "https://git.example.internal:8443/team/polaris.git",
      "ssh://git@example.internal/team/polaris.git",
      "git@github.com:rogers-group-inc/polaris.git",
      "git://example.internal/polaris.git",
    ]) {
      expect(isSafeRepoUrl(url), url).toBe(true);
    }
  });

  it("rejects values the shell would act on inside the double quotes", () => {
    // Double-quoting does not save this: $(…) and backticks expand inside them.
    for (const url of [
      'https://example.com/x.git"; id; #',
      "https://example.com/$(id).git",
      "https://example.com/`id`.git",
      "https://example.com/x.git; id",
      "https://example.com/x.git && id",
      "https://example.com/x.git | id",
      "https://example.com/a b.git",
      "",
    ]) {
      expect(isSafeRepoUrl(url), url).toBe(false);
    }
  });
});
