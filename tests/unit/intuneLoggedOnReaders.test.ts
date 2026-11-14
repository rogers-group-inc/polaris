/**
 * tests/unit/intuneLoggedOnReaders.test.ts — the two Graph reads behind the
 * Intune last logged-on user (business rule 186):
 *   - fetchIntuneLoggedOnUsers — per-device `usersLoggedOn` through Graph
 *     BETA $batch (the property is absent from v1.0); a failed sub-response
 *     leaves that device out, a non-GUID id never reaches a URL.
 *   - resolveUserPrincipalNames — primary-user pairs name accounts for free,
 *     the rest are read from /users/{id} and cached; an unreadable one is
 *     counted, not raised.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/utils/sleep.js", () => ({ sleep: vi.fn(async () => {}) }));

import { fetchIntuneLoggedOnUsers, resolveUserPrincipalNames } from "../../src/services/entraIdService.js";

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const isToken = (url: string) => new URL(url).hostname === "login.microsoftonline.com";

let seq = 0;
const cfg = () => ({ tenantId: `logon-t${++seq}`, clientId: "c", clientSecret: "s" });

const MA = "11111111-1111-1111-1111-111111111111";
const MB = "22222222-2222-2222-2222-222222222222";
const U1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const U3 = "cccccccc-cccc-cccc-cccc-cccccccccccc";

afterEach(() => vi.unstubAllGlobals());

describe("fetchIntuneLoggedOnUsers", () => {
  it("reads usersLoggedOn per device via beta $batch and keeps only the devices that answered", async () => {
    let batchUrl = "";
    let batchBody: any = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
      if (isToken(url)) return json({ access_token: "tok", expires_in: 3600 });
      batchUrl = url;
      batchBody = JSON.parse(init.body);
      return json({ responses: [
        { id: MA, status: 200, body: { id: MA, usersLoggedOn: [
          { userId: U1.toUpperCase(), lastLogOnDateTime: "2026-11-10T07:30:00Z" },
          { userId: "not-a-guid", lastLogOnDateTime: "2026-11-10T07:30:00Z" },
          { userId: U2, lastLogOnDateTime: "garbage" },
        ] } },
        { id: MB, status: 404, body: { error: { code: "NotFound" } } },
      ] });
    }));
    const res = await fetchIntuneLoggedOnUsers(cfg() as any, [MA, MB, "x' or 1 eq 1"]);
    expect(batchUrl).toBe("https://graph.microsoft.com/beta/$batch");
    expect(batchBody.requests.map((r: any) => r.url)).toEqual([
      `/deviceManagement/managedDevices/${MA}?$select=id,usersLoggedOn`,
      `/deviceManagement/managedDevices/${MB}?$select=id,usersLoggedOn`,
    ]);
    expect(res.logons.get(MA)).toEqual([{ userId: U1, lastLogOnDateTime: "2026-11-10T07:30:00Z" }]);
    expect(res.logons.has(MB)).toBe(false);
  });

  it("a device that reports no logons is a real, empty answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (isToken(url)
      ? json({ access_token: "tok", expires_in: 3600 })
      : json({ responses: [{ id: MA, status: 200, body: { id: MA } }] }))));
    const res = await fetchIntuneLoggedOnUsers(cfg() as any, [MA]);
    expect(res.logons.get(MA)).toEqual([]);
  });
});

describe("resolveUserPrincipalNames", () => {
  it("names primary users without a read, reads the rest, and counts what it cannot name", async () => {
    let batchBody: any = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
      if (isToken(url)) return json({ access_token: "tok", expires_in: 3600 });
      batchBody = JSON.parse(init.body);
      return json({ responses: [
        { id: U2, status: 200, body: { id: U2, userPrincipalName: "asmith@corp.example" } },
        { id: U3, status: 403, body: { error: { code: "Authorization_RequestDenied" } } },
      ] });
    }));
    const res = await resolveUserPrincipalNames(cfg() as any, [U1, U2, U3], new Map([[U1, "jdoe@corp.example"]]));
    expect(batchBody.requests.map((r: any) => r.url)).toEqual([
      `/users/${U2}?$select=id,userPrincipalName`,
      `/users/${U3}?$select=id,userPrincipalName`,
    ]);
    expect(res.upns).toEqual(new Map([[U1, "jdoe@corp.example"], [U2, "asmith@corp.example"]]));
    expect(res.unresolved).toBe(1);
  });

  it("caches a name it read, so the next run asks Graph nothing", async () => {
    const c = cfg();
    const fetchMock = vi.fn(async (url: string) => (isToken(url)
      ? json({ access_token: "tok", expires_in: 3600 })
      : json({ responses: [{ id: U2, status: 200, body: { id: U2, userPrincipalName: "asmith@corp.example" } }] })));
    vi.stubGlobal("fetch", fetchMock);
    await resolveUserPrincipalNames(c as any, [U2], new Map());
    const calls = fetchMock.mock.calls.length;
    const again = await resolveUserPrincipalNames(c as any, [U2], new Map());
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(again.upns.get(U2)).toBe("asmith@corp.example");
  });
});
