/**
 * tests/unit/allocationTemplateService.test.ts — saved multi-subnet allocation
 * templates (CQ-T010): validation (name, at least one entry, /8–/32, VLAN
 * 1–4094, names on non-skip rows), normalization (a skip row keeps only its
 * prefix, names trimmed), case-insensitive name uniqueness on create and
 * rename, 404s, and the list sorted by name.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { listTemplates, saveTemplate, deleteTemplate, type AllocationTemplate } from "../../src/services/allocationTemplateService.js";

const findUnique = stubbed(prisma.setting.findUnique);
const upsert = stubbed(prisma.setting.upsert);
let stored: AllocationTemplate[] = [];

beforeEach(() => {
  resetDbStub();
  stored = [];
  findUnique.mockImplementation(async () => ({ key: "networkAllocationTemplates", value: stored }));
  upsert.mockImplementation(async ({ update }: { update: { value: AllocationTemplate[] } }) => { stored = update.value; return {}; });
});

const site = { name: "Site", entries: [{ name: "Users", prefixLength: 24, vlan: 10 }] };

describe("saveTemplate validation", () => {
  it.each([
    [{ name: " ", entries: site.entries }, /name is required/],
    [{ name: "X", entries: [] }, /at least one entry/],
    [{ name: "X", entries: [{ name: "a", prefixLength: 33 }] }, /invalid prefix length/],
    [{ name: "X", entries: [{ name: "a", prefixLength: 7 }] }, /invalid prefix length/],
    [{ name: "X", entries: [{ name: " ", prefixLength: 24 }] }, /must have a name/],
    [{ name: "X", entries: [{ name: "a", prefixLength: 24, vlan: 4095 }] }, /invalid VLAN/],
  ])("refuses %o", async (input, msg) => {
    await expect(saveTemplate(input as never)).rejects.toThrow(msg);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("a skip row needs no name and keeps only its prefix", async () => {
    const t = await saveTemplate({ name: "Gap", entries: [{ skip: true, name: "ignored", prefixLength: 25, vlan: 9 } as never] });
    expect(t.entries).toEqual([{ skip: true, prefixLength: 25 }]);
  });
});

describe("saveTemplate create / update", () => {
  it("creates with an id, a trimmed name and normalized entries", async () => {
    const t = await saveTemplate({ name: "  Branch  ", entries: [{ name: " Voice ", prefixLength: 24, vlan: "20" as never }] });
    expect(t.id).toMatch(/[0-9a-f-]{36}/);
    expect(t).toMatchObject({ name: "Branch", entries: [{ name: "Voice", prefixLength: 24, vlan: 20 }] });
    expect(stored).toHaveLength(1);
  });

  it("refuses a duplicate name, case-insensitively", async () => {
    await saveTemplate(site);
    await expect(saveTemplate({ ...site, name: "SITE" })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("updates in place by id, and refuses a rename onto another template's name", async () => {
    const a = await saveTemplate(site);
    const b = await saveTemplate({ ...site, name: "Other" });
    const renamed = await saveTemplate({ id: a.id, name: "Renamed", entries: site.entries, anchorPrefix: 22 });
    expect(renamed).toMatchObject({ id: a.id, name: "Renamed", anchorPrefix: 22 });
    await expect(saveTemplate({ id: b.id, name: "renamed", entries: site.entries })).rejects.toMatchObject({ httpStatus: 409 });
    await expect(saveTemplate({ id: "nope", name: "Z", entries: site.entries })).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("listTemplates / deleteTemplate", () => {
  it("lists sorted by name; an absent or malformed setting reads as none", async () => {
    await saveTemplate({ ...site, name: "zeta" });
    await saveTemplate({ ...site, name: "Alpha" });
    expect((await listTemplates()).map((t) => t.name)).toEqual(["Alpha", "zeta"]);
    findUnique.mockResolvedValueOnce(null);
    expect(await listTemplates()).toEqual([]);
    findUnique.mockResolvedValueOnce({ value: { not: "an array" } });
    expect(await listTemplates()).toEqual([]);
  });

  it("deletes by id and 404s an unknown one", async () => {
    const t = await saveTemplate(site);
    await deleteTemplate(t.id);
    expect(stored).toEqual([]);
    await expect(deleteTemplate(t.id)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
