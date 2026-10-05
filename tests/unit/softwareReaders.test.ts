/**
 * tests/unit/softwareReaders.test.ts
 *
 * The two remote installed-software readers behind the Software tab:
 *   - entraIdService.fetchIntuneDetectedApps — per-device detectedApps through
 *     Graph BETA $batch; a failed sub-response leaves that device out (so its
 *     stored list is kept), a non-GUID id never reaches a URL, nextLink pages
 *     are followed.
 *   - azureArcService.fetchArcSoftware — Change Tracking's ConfigurationData
 *     through the Log Analytics query API (its own token audience); the KQL
 *     builders refuse anything that is not an Arc machine id.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/utils/sleep.js", () => ({ sleep: vi.fn(async () => {}) }));

import { fetchIntuneDetectedApps } from "../../src/services/entraIdService.js";
import {
  buildArcSoftwareQuery,
  fetchArcSoftware,
  logAnalyticsRows,
} from "../../src/services/azureArcService.js";

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const isToken = (url: string) => new URL(url).hostname === "login.microsoftonline.com";

let seq = 0;
const cfg = (extra: Record<string, unknown> = {}) => ({ tenantId: `sw-t${++seq}`, clientId: "c", clientSecret: "s", ...extra });

afterEach(() => vi.unstubAllGlobals());

describe("fetchIntuneDetectedApps", () => {
  const MA = "11111111-1111-1111-1111-111111111111";
  const MB = "22222222-2222-2222-2222-222222222222";

  it("reads each device's detectedApps via beta $batch and keeps only the devices that answered", async () => {
    const calls: string[] = [];
    let batchBody: any = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
      if (isToken(url)) return json({ access_token: "tok", expires_in: 3600 });
      calls.push(url);
      if (url === "https://graph.microsoft.com/beta/$batch") {
        batchBody = JSON.parse(init.body);
        return json({
          responses: [
            { id: MA, status: 200, body: { value: [
              { displayName: "Microsoft Teams", version: "24.1", publisher: "Microsoft", sizeInByte: 1234, platform: "windows" },
              { displayName: "  ", version: "1" },
            ], "@odata.nextLink": "https://graph.microsoft.com/beta/deviceManagement/managedDevices/x/detectedApps?$skiptoken=2" } },
            { id: MB, status: 404, body: { error: { code: "NotFound" } } },
          ],
        });
      }
      if (url.includes("$skiptoken=2")) {
        return json({ value: [{ displayName: "7-Zip", version: "24.08", publisher: null, sizeInByte: 0, platform: "unknown" }] });
      }
      return json({}, 500);
    }));

    const res = await fetchIntuneDetectedApps(cfg() as any, [MA, MB, "not-a-guid"]);
    expect(batchBody.requests.map((r: any) => r.url)).toEqual([
      `/deviceManagement/managedDevices/${MA}/detectedApps`,
      `/deviceManagement/managedDevices/${MB}/detectedApps`,
    ]);
    expect(res.apps.has(MB)).toBe(false);
    expect(res.apps.get(MA)).toEqual([
      { displayName: "Microsoft Teams", version: "24.1", publisher: "Microsoft", sizeInByte: 1234, platform: "windows" },
      { displayName: "7-Zip", version: "24.08", publisher: null, sizeInByte: null, platform: null },
    ]);
  });

  it("a $batch call that throws is counted, not raised", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (isToken(url) ? json({ access_token: "tok", expires_in: 3600 }) : json({ error: { message: "nope" } }, 500))));
    const res = await fetchIntuneDetectedApps(cfg() as any, [MA]);
    expect(res.apps.size).toBe(0);
    expect(res.failedBatches).toBe(1);
  });
});

describe("Arc software KQL", () => {
  const ok = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/RG-1/providers/Microsoft.HybridCompute/machines/srv-01";

  it("quotes only well-formed Arc machine ids, lowercased", () => {
    const q = buildArcSoftwareQuery([ok, "/subscriptions/x/resourcegroups/rg/providers/microsoft.hybridcompute/machines/a' or 1==1 //"]);
    expect(q).toContain(`'${ok.toLowerCase()}'`);
    expect(q).not.toContain("1==1");
    expect(q).toContain('SoftwareType != "Update"');
    expect(buildArcSoftwareQuery(["/subscriptions/x/foo"])).toBeNull();
  });

  it("maps a Log Analytics table to row objects", () => {
    expect(logAnalyticsRows({ tables: [{ columns: [{ name: "a" }, { name: "b" }], rows: [[1, "x"], [2, "y"]] }] }))
      .toEqual([{ a: 1, b: "x" }, { a: 2, b: "y" }]);
    expect(logAnalyticsRows({})).toEqual([]);
  });
});

describe("fetchArcSoftware", () => {
  const WS = "33333333-3333-3333-3333-333333333333";
  const RID = "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg/providers/microsoft.hybridcompute/machines/srv-01";

  it("mints a Log Analytics token, lists the machines, then reads their software", async () => {
    const scopes: string[] = [];
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
      if (isToken(url)) {
        scopes.push(new URLSearchParams(String(init.body)).get("scope") ?? "");
        return json({ access_token: "la-tok", expires_in: 3600 });
      }
      expect(url).toBe(`https://api.loganalytics.io/v1/workspaces/${WS}/query`);
      const body = JSON.parse(init.body);
      queries.push(body.query);
      expect(body.timespan).toBe("P3D");
      if (body.query.includes("distinct rid")) {
        return json({ tables: [{ columns: [{ name: "rid" }], rows: [[RID], ["/subscriptions/bad"]] }] });
      }
      return json({ tables: [{
        columns: [{ name: "rid" }, { name: "SoftwareName" }, { name: "CurrentVersion" }, { name: "Publisher" }, { name: "Architecture" }, { name: "SoftwareType" }],
        rows: [[RID, "nginx", "1.26.2", "", "x86_64", "Package"], [RID, "", "1", "", "", ""]],
      }] });
    }));
    const res = await fetchArcSoftware(cfg({ logAnalyticsWorkspaceIds: [WS] }) as any);
    expect(scopes).toEqual(["https://api.loganalytics.io/.default"]);
    expect(queries).toHaveLength(2);
    expect(res.failedWorkspaces).toBe(0);
    expect(res.byResourceId.get(RID)).toEqual([
      { name: "nginx", version: "1.26.2", publisher: null, architecture: "x86_64", softwareType: "Package" },
    ]);
  });

  it("a 403 on a workspace is a failed workspace with an actionable message", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (isToken(url)
      ? json({ access_token: "la-tok", expires_in: 3600 })
      : json({ error: { message: "InsufficientAccessError" } }, 403))));
    const log = vi.fn();
    const res = await fetchArcSoftware(cfg({ logAnalyticsWorkspaceIds: [WS] }) as any, undefined, log);
    expect(res.failedWorkspaces).toBe(1);
    expect(log).toHaveBeenCalledWith("discover.arc.software", "error", expect.stringContaining("Log Analytics Reader"));
  });
});
