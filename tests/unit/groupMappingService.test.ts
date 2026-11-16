/**
 * tests/unit/groupMappingService.test.ts — own unit suite for
 * src/services/groupMappingService.ts (CQ-T010 batch 8c).
 *
 * normalizeGroupKey + the resolver's matching rules also have a suite in
 * groupMappingResolve.test.ts; this one adds the provider translation, the
 * enabled-mappings cache, and the CRUD half with its audit Events (the
 * admin-equivalent warning, rule 114(j)'s grant reads).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  GROUP_MAPPING_PROVIDERS,
  createGroupMapping,
  deleteGroupMapping,
  getGroupMapping,
  invalidateGroupMappingCacheForTests,
  listGroupMappings,
  mappingGrantState,
  mappingProviderForAuthProvider,
  normalizeGroupKey,
  resolveGroupsToAccess,
  roleGrantFor,
  updateGroupMapping,
} from "../../src/services/groupMappingService.js";

const ADMIN = { users: "fullwrite", roles: "fullwrite" };
const READER = { assets: "read" };

function mappingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "gm-1",
    provider: "ldap",
    groupKey: "cn=ops,dc=example",
    groupLabel: "CN=Ops,DC=example",
    roleId: null as string | null,
    regionTags: [] as string[],
    otherTags: [] as string[],
    enabled: true,
    description: null as string | null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    role: null as { name: string } | null,
    ...overrides,
  };
}

/** details.diff of the first logged Event. */
function eventDiff(): Record<string, any> {
  return (eventLog.logEvent.mock.calls[0][0].details as { diff: Record<string, any> }).diff;
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  invalidateGroupMappingCacheForTests();
  stubbed(prisma.groupMapping.create).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    mappingRow({ id: "gm-new", ...data }),
  );
  stubbed(prisma.groupMapping.update).mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    mappingRow({ ...data }),
  );
});

describe("GROUP_MAPPING_PROVIDERS / mappingProviderForAuthProvider", () => {
  it("names exactly the four mapping providers", () => {
    expect([...GROUP_MAPPING_PROVIDERS]).toEqual(["oidc", "ldap", "saml", "entra-proxy"]);
  });

  it("translates the SAML authProvider 'azure' to 'saml' and passes everything else through", () => {
    expect(mappingProviderForAuthProvider("azure")).toBe("saml");
    expect(mappingProviderForAuthProvider("ldap")).toBe("ldap");
    expect(mappingProviderForAuthProvider("oidc")).toBe("oidc");
    expect(mappingProviderForAuthProvider("local")).toBe("local");
  });
});

describe("normalizeGroupKey", () => {
  it("lowercases ldap + entra-proxy keys, trims only oidc / saml", () => {
    expect(normalizeGroupKey("ldap", "  CN=Ops,DC=X ")).toBe("cn=ops,dc=x");
    expect(normalizeGroupKey("entra-proxy", "ABC-DEF")).toBe("abc-def");
    expect(normalizeGroupKey("saml", " Ops ")).toBe("Ops");
    expect(normalizeGroupKey("oidc", "Ops")).toBe("Ops");
  });

  it("returns '' for blanks and non-strings", () => {
    expect(normalizeGroupKey("ldap", "   ")).toBe("");
    expect(normalizeGroupKey("ldap", 7)).toBe("");
    expect(normalizeGroupKey("ldap", null)).toBe("");
  });
});

describe("resolveGroupsToAccess", () => {
  it("is empty without a query for an unknown provider, no groups, or only blank groups", async () => {
    const empty = { roleId: null, regionTags: [], otherTags: [], matchedGroups: [] };
    expect(await resolveGroupsToAccess("local", ["x"])).toEqual(empty);
    expect(await resolveGroupsToAccess("ldap", [])).toEqual(empty);
    expect(await resolveGroupsToAccess("ldap", "cn=ops")).toEqual(empty);
    expect(await resolveGroupsToAccess("ldap", ["", "  ", 5])).toEqual(empty);
    expect(prisma.groupMapping.findMany).not.toHaveBeenCalled();
  });

  it("reads only enabled mappings for the provider", async () => {
    stubbed(prisma.groupMapping.findMany).mockResolvedValue([]);
    await resolveGroupsToAccess("oidc", ["ops"]);
    expect(stubbed(prisma.groupMapping.findMany).mock.calls[0][0].where).toEqual({ provider: "oidc", enabled: true });
  });

  it("a single matched role is used without a role lookup; tags union", async () => {
    stubbed(prisma.groupMapping.findMany).mockResolvedValue([
      { groupKey: "cn=ops", roleId: "r1", regionTags: ["East"], otherTags: ["noc"] },
      { groupKey: "cn=dev", roleId: null, regionTags: ["west"], otherTags: [] },
      { groupKey: "cn=other", roleId: "r9", regionTags: ["north"], otherTags: [] },
    ]);
    const out = await resolveGroupsToAccess("ldap", ["CN=Ops", "cn=dev"]);
    expect(out.roleId).toBe("r1");
    expect(out.matchedGroups).toEqual(["cn=ops", "cn=dev"]);
    expect(out.regionTags.map((t) => t.toLowerCase()).sort()).toEqual(["east", "west"]);
    expect(out.otherTags).toEqual(["noc"]);
    expect(prisma.role.findMany).not.toHaveBeenCalled();
  });

  it("two mappings naming the same role count as one", async () => {
    stubbed(prisma.groupMapping.findMany).mockResolvedValue([
      { groupKey: "a", roleId: "r1", regionTags: [], otherTags: [] },
      { groupKey: "b", roleId: "r1", regionTags: [], otherTags: [] },
    ]);
    expect((await resolveGroupsToAccess("oidc", ["a", "b"])).roleId).toBe("r1");
    expect(prisma.role.findMany).not.toHaveBeenCalled();
  });

  it("several matched roles: the highest-privilege one wins", async () => {
    stubbed(prisma.groupMapping.findMany).mockResolvedValue([
      { groupKey: "a", roleId: "r-read", regionTags: [], otherTags: [] },
      { groupKey: "b", roleId: "r-admin", regionTags: [], otherTags: [] },
    ]);
    stubbed(prisma.role.findMany).mockResolvedValue([
      { id: "r-read", permissions: READER },
      { id: "r-admin", permissions: ADMIN },
    ]);
    expect((await resolveGroupsToAccess("oidc", ["a", "b"])).roleId).toBe("r-admin");
    expect(stubbed(prisma.role.findMany).mock.calls[0][0].where).toEqual({ id: { in: ["r-read", "r-admin"] } });
  });

  it("serves repeat resolves from the cache, and a write invalidates it", async () => {
    stubbed(prisma.groupMapping.findMany).mockResolvedValue([]);
    await resolveGroupsToAccess("oidc", ["a"]);
    await resolveGroupsToAccess("oidc", ["b"]);
    expect(prisma.groupMapping.findMany).toHaveBeenCalledTimes(1);
    // another provider has its own entry
    await resolveGroupsToAccess("saml", ["a"]);
    expect(prisma.groupMapping.findMany).toHaveBeenCalledTimes(2);

    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(mappingRow());
    await deleteGroupMapping("gm-1", "alice");
    await resolveGroupsToAccess("oidc", ["a"]);
    expect(prisma.groupMapping.findMany).toHaveBeenCalledTimes(3);
  });

  it("re-reads after the 30 s TTL", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
      stubbed(prisma.groupMapping.findMany).mockResolvedValue([]);
      await resolveGroupsToAccess("oidc", ["a"]);
      vi.setSystemTime(new Date("2026-11-14T00:00:29Z"));
      await resolveGroupsToAccess("oidc", ["a"]);
      expect(prisma.groupMapping.findMany).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-11-14T00:00:31Z"));
      await resolveGroupsToAccess("oidc", ["a"]);
      expect(prisma.groupMapping.findMany).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("listGroupMappings / getGroupMapping", () => {
  it("filters by provider when given, orders by provider then key, and summarizes", async () => {
    stubbed(prisma.groupMapping.findMany).mockResolvedValue([mappingRow({ roleId: "r1", role: { name: "ops" } })]);
    const out = await listGroupMappings("ldap");
    const args = stubbed(prisma.groupMapping.findMany).mock.calls[0][0];
    expect(args.where).toEqual({ provider: "ldap" });
    expect(args.orderBy).toEqual([{ provider: "asc" }, { groupKey: "asc" }]);
    expect(out[0]).toMatchObject({ id: "gm-1", roleName: "ops" });
    expect(out[0]).not.toHaveProperty("role");
  });

  it("lists every provider when none is given", async () => {
    stubbed(prisma.groupMapping.findMany).mockResolvedValue([]);
    await listGroupMappings();
    expect(stubbed(prisma.groupMapping.findMany).mock.calls[0][0].where).toBeUndefined();
  });

  it("getGroupMapping 404s on an unknown id and maps a missing role to roleName null", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValueOnce(null);
    await expect(getGroupMapping("x")).rejects.toMatchObject({ httpStatus: 404 });
    stubbed(prisma.groupMapping.findUnique).mockResolvedValueOnce(mappingRow());
    expect((await getGroupMapping("gm-1")).roleName).toBeNull();
  });
});

describe("roleGrantFor / mappingGrantState", () => {
  it("roleGrantFor is null without a role id and reads name + permissions otherwise", async () => {
    expect(await roleGrantFor(null)).toBeNull();
    expect(await roleGrantFor("")).toBeNull();
    stubbed(prisma.role.findUnique).mockResolvedValue({ name: "ops", permissions: READER });
    expect(await roleGrantFor("r1")).toEqual({ name: "ops", permissions: READER });
    expect(stubbed(prisma.role.findUnique).mock.calls[0][0]).toEqual({
      where: { id: "r1" },
      select: { name: true, permissions: true },
    });
  });

  it("mappingGrantState reads the role, group and enabled flag", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue({ roleId: "r1", groupKey: "k", groupLabel: "K", enabled: true });
    expect(await mappingGrantState("gm-1")).toEqual({ roleId: "r1", groupKey: "k", groupLabel: "K", enabled: true });
    expect(stubbed(prisma.groupMapping.findUnique).mock.calls[0][0].select).toEqual({
      roleId: true,
      groupKey: true,
      groupLabel: true,
      enabled: true,
    });
  });
});

describe("createGroupMapping", () => {
  it("400s on an unknown provider", async () => {
    await expect(createGroupMapping({ provider: "kerberos", groupKey: "x" })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("400s on a blank group key", async () => {
    await expect(createGroupMapping({ provider: "ldap", groupKey: "  " })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("400s on a group key over 512 characters", async () => {
    await expect(createGroupMapping({ provider: "oidc", groupKey: "g".repeat(513) })).rejects.toMatchObject({ httpStatus: 400 });
    stubbed(prisma.groupMapping.create).mockClear();
    await createGroupMapping({ provider: "oidc", groupKey: "g".repeat(512) });
    expect(prisma.groupMapping.create).toHaveBeenCalledTimes(1);
  });

  it("400s on a description over 200 characters", async () => {
    await expect(
      createGroupMapping({ provider: "oidc", groupKey: "g", description: "d".repeat(201) }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("400s when the named role does not exist", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue(null);
    await expect(createGroupMapping({ provider: "oidc", groupKey: "g", roleId: "ghost" })).rejects.toMatchObject({
      httpStatus: 400,
    });
    expect(prisma.groupMapping.create).not.toHaveBeenCalled();
  });

  it("stores the normalized key, keeps the typed label, normalizes tags, and defaults enabled", async () => {
    const out = await createGroupMapping(
      {
        provider: "ldap",
        groupKey: "  CN=Ops,DC=Example ",
        regionTags: [" East ", "east", ""],
        otherTags: ["noc"],
        description: "  on-call  ",
        roleId: "",
      },
      "alice",
    );
    const data = stubbed(prisma.groupMapping.create).mock.calls[0][0].data;
    expect(data).toEqual({
      provider: "ldap",
      groupKey: "cn=ops,dc=example",
      groupLabel: "CN=Ops,DC=Example",
      roleId: null,
      regionTags: ["East"],
      otherTags: ["noc"],
      enabled: true,
      description: "on-call",
    });
    expect(out).toMatchObject({ id: "gm-new", groupKey: "cn=ops,dc=example", roleName: null });
    expect(prisma.role.findUnique).not.toHaveBeenCalled();
  });

  it("maps a unique-index collision to 409", async () => {
    stubbed(prisma.groupMapping.create).mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(createGroupMapping({ provider: "oidc", groupKey: "ops" })).rejects.toMatchObject({ httpStatus: 409 });
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("rethrows any other create error", async () => {
    stubbed(prisma.groupMapping.create).mockRejectedValue(new Error("boom"));
    await expect(createGroupMapping({ provider: "oidc", groupKey: "ops" })).rejects.toThrow("boom");
  });

  it("writes an info-level groupMapping.created Event for an ordinary role", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue({ name: "reader", permissions: READER });
    await createGroupMapping({ provider: "oidc", groupKey: "ops", roleId: "r1", enabled: false }, "alice");
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({
      action: "groupMapping.created",
      resourceType: "groupMapping",
      resourceId: "gm-new",
      actor: "alice",
      level: undefined,
      details: { provider: "oidc", groupKey: "ops", roleId: "r1", enabled: false },
    });
    expect(ev.message).not.toContain("ADMIN");
  });

  it("stamps a warning Event when the role is admin-equivalent", async () => {
    stubbed(prisma.role.findUnique).mockResolvedValue({ name: "admin", permissions: ADMIN });
    await createGroupMapping({ provider: "saml", groupKey: "Admins", roleId: "r-admin" }, "alice");
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev.level).toBe("warning");
    expect(ev.message).toContain('ADMIN-equivalent role "admin"');
  });

  it("invalidates the resolver cache", async () => {
    stubbed(prisma.groupMapping.findMany).mockResolvedValue([]);
    await resolveGroupsToAccess("oidc", ["ops"]);
    await createGroupMapping({ provider: "oidc", groupKey: "ops" });
    await resolveGroupsToAccess("oidc", ["ops"]);
    expect(prisma.groupMapping.findMany).toHaveBeenCalledTimes(2);
  });
});

describe("updateGroupMapping", () => {
  it("404s on an unknown id", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(null);
    await expect(updateGroupMapping("x", { enabled: false })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("is a no-op (no write, no Event) when nothing changes", async () => {
    const before = mappingRow({ regionTags: ["east"], description: "d" });
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(before);
    const out = await updateGroupMapping("gm-1", {
      groupKey: "CN=Ops,DC=example",
      regionTags: ["east"],
      otherTags: [],
      enabled: true,
      description: " d ",
      roleId: null,
    });
    expect(prisma.groupMapping.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    expect(out.id).toBe("gm-1");
  });

  it("re-normalizes a changed group key under the stored provider and records the label diff", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(mappingRow());
    await updateGroupMapping("gm-1", { groupKey: " CN=NOC,DC=example " }, "alice");
    const { data } = stubbed(prisma.groupMapping.update).mock.calls[0][0];
    expect(data).toEqual({ groupKey: "cn=noc,dc=example", groupLabel: "CN=NOC,DC=example" });
    expect(eventDiff().groupKey).toEqual({
      from: "CN=Ops,DC=example",
      to: "CN=NOC,DC=example",
    });
  });

  it("a case-only label change on an ldap key still saves the new label", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(mappingRow());
    await updateGroupMapping("gm-1", { groupKey: "cn=ops,dc=example" });
    expect(stubbed(prisma.groupMapping.update).mock.calls[0][0].data).toEqual({
      groupKey: "cn=ops,dc=example",
      groupLabel: "cn=ops,dc=example",
    });
  });

  it("400s on a blank or over-long group key", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(mappingRow());
    await expect(updateGroupMapping("gm-1", { groupKey: " " })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(updateGroupMapping("gm-1", { groupKey: "x".repeat(513) })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("diffs role, tags, enabled and description; '' clears the role", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(
      mappingRow({ roleId: "r1", regionTags: ["east"], otherTags: ["a"], description: "old" }),
    );
    await updateGroupMapping("gm-1", {
      roleId: "",
      regionTags: ["west"],
      otherTags: ["a", "b"],
      enabled: false,
      description: "",
    });
    const { data } = stubbed(prisma.groupMapping.update).mock.calls[0][0];
    expect(data).toEqual({ roleId: null, regionTags: ["west"], otherTags: ["a", "b"], enabled: false, description: null });
    const diff = eventDiff();
    expect(Object.keys(diff).sort()).toEqual(["description", "enabled", "otherTags", "regionTags", "roleId"]);
    expect(diff.roleId).toEqual({ from: "r1", to: null });
  });

  it("validates the resulting role even when only tags changed, and warns when it is admin-equivalent", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(mappingRow({ roleId: "r-admin" }));
    stubbed(prisma.role.findUnique).mockResolvedValue({ name: "admin", permissions: ADMIN });
    await updateGroupMapping("gm-1", { otherTags: ["x"] }, "alice");
    expect(stubbed(prisma.role.findUnique).mock.calls[0][0].where).toEqual({ id: "r-admin" });
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "groupMapping.updated", level: "warning", actor: "alice" });
  });

  it("400s when switching to a role that does not exist", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(mappingRow());
    stubbed(prisma.role.findUnique).mockResolvedValue(null);
    await expect(updateGroupMapping("gm-1", { roleId: "ghost" })).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.groupMapping.update).not.toHaveBeenCalled();
  });

  it("maps a P2002 on update to 409", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(mappingRow());
    stubbed(prisma.groupMapping.update).mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(updateGroupMapping("gm-1", { groupKey: "cn=other" })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("tag comparison is order-sensitive: a reorder is a change", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(mappingRow({ regionTags: ["a", "b"] }));
    await updateGroupMapping("gm-1", { regionTags: ["b", "a"] });
    expect(stubbed(prisma.groupMapping.update).mock.calls[0][0].data).toEqual({ regionTags: ["b", "a"] });
  });
});

describe("deleteGroupMapping", () => {
  it("404s on an unknown id", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(null);
    await expect(deleteGroupMapping("x")).rejects.toMatchObject({ httpStatus: 404 });
    expect(prisma.groupMapping.delete).not.toHaveBeenCalled();
  });

  it("deletes and audits with the label", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(mappingRow());
    await deleteGroupMapping("gm-1", "alice");
    expect(stubbed(prisma.groupMapping.delete).mock.calls[0][0]).toEqual({ where: { id: "gm-1" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "groupMapping.deleted",
      resourceId: "gm-1",
      resourceName: "CN=Ops,DC=example",
      actor: "alice",
    });
  });

  it("falls back to the key when the label is null", async () => {
    stubbed(prisma.groupMapping.findUnique).mockResolvedValue(mappingRow({ groupLabel: null }));
    await deleteGroupMapping("gm-1");
    expect(eventLog.logEvent.mock.calls[0][0].resourceName).toBe("cn=ops,dc=example");
  });
});
