/**
 * tests/unit/deviceIconUpdateKey.test.ts — `updateIconKey`, the edit behind
 * the Device Icons card's inline editor (PUT /device-icons/:id).
 *
 * Re-keying changes an icon's manufacturer, asset type or model, or which of
 * the two it matches by, and keeps the image. The risk is the one upload does
 * on purpose: upload UPSERTS, so reaching a held key replaces that icon's
 * image. A re-key must refuse instead (409), or editing one icon silently
 * deletes another. Prisma is mocked; resvg is stubbed (native, unused here).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();

vi.mock("../../src/db.js", () => ({
  prisma: {
    deviceIcon: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));
vi.mock("@resvg/resvg-js", () => ({ Resvg: class {} }));

const { updateIconKey } = await import("../../src/services/deviceIconService.js");

const ROW = {
  id: "icon-1", scope: "manufacturer-type", key: "APC/server", filename: "apc.png",
  mimeType: "image/png", size: 1234, uploadedBy: "admin", uploadedAt: new Date("2026-10-01T00:00:00Z"),
};

beforeEach(() => {
  findUnique.mockReset();
  update.mockReset();
});

/** First findUnique = the icon by id; second = whoever holds the target key. */
function stubLookups(existing: unknown, holder: unknown) {
  findUnique.mockResolvedValueOnce(existing).mockResolvedValueOnce(holder);
}

describe("updateIconKey", () => {
  it("re-keys an icon to a new manufacturer + type and reports the old key", async () => {
    stubLookups({ scope: "manufacturer-type", key: "APC by Schneide/server" }, null);
    update.mockResolvedValue(ROW);

    const out = await updateIconKey("icon-1", { scope: "manufacturer-type", manufacturer: "APC", typeOrModel: "Server" });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "icon-1" },
      data: { scope: "manufacturer-type", key: "APC/server" }, // type tail lowercased
    }));
    expect(out.previous).toEqual({ scope: "manufacturer-type", key: "APC by Schneide/server" });
    expect(out.icon.key).toBe("APC/server");
  });

  it("moves an icon from matching by type to matching by model, model kept as typed", async () => {
    stubLookups({ scope: "manufacturer-type", key: "APC/server" }, null);
    update.mockResolvedValue({ ...ROW, scope: "manufacturer-model", key: "APC/Smart-UPS 1500" });

    await updateIconKey("icon-1", { scope: "manufacturer-model", manufacturer: "APC", typeOrModel: "Smart-UPS 1500" });
    expect(update.mock.calls[0][0].data).toEqual({ scope: "manufacturer-model", key: "APC/Smart-UPS 1500" });
  });

  it("refuses a key another icon holds, rather than replacing its image", async () => {
    stubLookups({ scope: "manufacturer-type", key: "APC/server" }, { id: "icon-2" });

    await expect(updateIconKey("icon-1", { scope: "manufacturer-type", manufacturer: "APC", typeOrModel: "firewall" }))
      .rejects.toMatchObject({ httpStatus: 409 });
    expect(update).not.toHaveBeenCalled();
  });

  it("saving an icon onto its own key is not a conflict", async () => {
    stubLookups({ scope: "manufacturer-type", key: "APC/server" }, { id: "icon-1" });
    update.mockResolvedValue(ROW);

    await expect(updateIconKey("icon-1", { scope: "manufacturer-type", manufacturer: "APC", typeOrModel: "server" }))
      .resolves.toBeTruthy();
  });

  it("turns a lost race with a concurrent upload (P2002) into the same 409", async () => {
    stubLookups({ scope: "manufacturer-type", key: "APC/server" }, null);
    update.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    await expect(updateIconKey("icon-1", { scope: "manufacturer-type", manufacturer: "APC", typeOrModel: "router" }))
      .rejects.toMatchObject({ httpStatus: 409 });
  });

  it("404s an icon that does not exist", async () => {
    stubLookups(null, null);
    await expect(updateIconKey("gone", { scope: "manufacturer-type", manufacturer: "APC", typeOrModel: "server" }))
      .rejects.toMatchObject({ httpStatus: 404 });
  });

  it("applies the upload's key rules: unknown type and blank manufacturer are 400", async () => {
    await expect(updateIconKey("icon-1", { scope: "manufacturer-type", manufacturer: "APC", typeOrModel: "toaster" }))
      .rejects.toMatchObject({ httpStatus: 400 });
    await expect(updateIconKey("icon-1", { scope: "manufacturer-model", manufacturer: "  ", typeOrModel: "X" }))
      .rejects.toMatchObject({ httpStatus: 400 });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
