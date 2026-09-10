/**
 * tests/unit/arcRunCommand.test.ts
 *
 * dispatchRunCommand itself — the ARM write. arcPublish.test.ts mocks this
 * function to test the orchestration around it, so the safety-critical
 * behaviour inside it is pinned here:
 *
 *   - the right script goes to the right OS (sending PowerShell through a
 *     shell as root is the failure mode)
 *   - an undeterminable OS is SKIPPED, never guessed
 *   - one machine's failure does not abort or silently shorten the batch
 *   - the opt-in flag is enforced at the lowest level, not just at the service
 *
 * Plus listRunCommandTargets, the roster read that feeds the picker — also
 * mocked by arcPublish.test.ts, which is how a version that never normalized
 * the raw ARM rows shipped with every machine's OS reading undefined.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { dispatchRunCommand, listRunCommandTargets } from "../../src/services/azureArcService.js";

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  };
}
const TOKEN_OK = res(200, { access_token: "tok", expires_in: 3600 });

/**
 * Is this the AAD token fetch rather than an ARM call? Compares the parsed
 * HOST, not a substring of the URL — a substring test also matches a URL that
 * merely carries the login host in its path or query, which is exactly the
 * confusion `js/incomplete-url-substring-sanitization` flags. It is only a
 * test double here, but the routing has to be unambiguous for the assertions
 * below to mean anything.
 */
const AAD_LOGIN_HOST = "login.microsoftonline.com";
function isTokenUrl(u: unknown): boolean {
  try {
    return new URL(String(u)).host === AAD_LOGIN_HOST;
  } catch {
    return false;
  }
}

let fetchMock: ReturnType<typeof vi.fn>;
let cfgSeq = 0;
let CONFIG: any;

/** Requests that were NOT the token fetch, in call order. */
function armCalls() {
  return fetchMock.mock.calls
    .filter(([u]) => !isTokenUrl(u))
    .map(([url, init]) => ({ url: String(url), init }));
}

beforeEach(() => {
  // Fresh clientId per test: azureArcService caches tokens per tenant:client.
  CONFIG = { tenantId: "t", clientId: `c${++cfgSeq}`, clientSecret: "s", allowRunCommand: true };
  fetchMock = vi.fn(async (url: string) =>
    isTokenUrl(url) ? TOKEN_OK : res(201, { id: "rc" }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function target(over: Partial<any> = {}) {
  return {
    armId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.HybridCompute/machines/m",
    name: "m", subscriptionId: "sub-1", resourceGroup: "rg-1", azureRegion: "eastus",
    osType: "linux", status: "Connected", ...over,
  };
}
const SCRIPTS = { windows: "WIN-BODY", linux: "LIN-BODY" };
const OPTS = { runCommandName: "polaris-ssh-onboarding" };

describe("opt-in gate", () => {
  it("refuses before touching the network when the flag is off", async () => {
    await expect(
      dispatchRunCommand({ ...CONFIG, allowRunCommand: false }, [target()], SCRIPTS, OPTS),
    ).rejects.toThrow(/not enabled/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the flag is merely truthy rather than true", async () => {
    await expect(
      dispatchRunCommand({ ...CONFIG, allowRunCommand: "yes" }, [target()], SCRIPTS, OPTS),
    ).rejects.toThrow(/not enabled/i);
  });
});

describe("per-OS script routing", () => {
  it("sends the shell script to Linux and PowerShell to Windows", async () => {
    const out = await dispatchRunCommand(
      CONFIG,
      [target({ name: "lin", osType: "Linux" }), target({ name: "win", osType: "Windows" })],
      SCRIPTS, OPTS,
    );
    expect(out.every((r) => r.dispatched)).toBe(true);

    const bodies = armCalls().map((c) => JSON.parse(c.init.body));
    const scripts = bodies.map((b) => b.properties.source.script);
    expect(scripts).toContain("LIN-BODY");
    expect(scripts).toContain("WIN-BODY");
    // The Linux machine must not have received PowerShell.
    const linCall = armCalls().find((c) => c.url.includes("/machines/lin"))!;
    expect(JSON.parse(linCall.init.body).properties.source.script).toBe("LIN-BODY");
  });

  it("SKIPS a machine whose OS is unknown instead of guessing", async () => {
    const out = await dispatchRunCommand(CONFIG, [target({ osType: null })], SCRIPTS, OPTS);
    expect(out[0]).toMatchObject({ dispatched: false });
    expect(out[0].skipped).toMatch(/unknown OS/i);
    expect(armCalls()).toHaveLength(0); // nothing was executed
  });

  it("skips a machine with no Azure region rather than sending an invalid body", async () => {
    const out = await dispatchRunCommand(CONFIG, [target({ azureRegion: "" })], SCRIPTS, OPTS);
    expect(out[0].skipped).toMatch(/region/i);
    expect(armCalls()).toHaveLength(0);
  });
});

describe("request shape", () => {
  it("PUTs to the machine's runCommands resource with its own scope", async () => {
    await dispatchRunCommand(
      CONFIG, [target({ name: "srv1", subscriptionId: "sub-9", resourceGroup: "rg-9" })], SCRIPTS, OPTS,
    );
    const c = armCalls()[0];
    expect(c.init.method).toBe("PUT");
    expect(c.url).toContain("/subscriptions/sub-9/resourceGroups/rg-9/");
    expect(c.url).toContain("/providers/Microsoft.HybridCompute/machines/srv1/runCommands/polaris-ssh-onboarding");
    expect(c.url).toMatch(/api-version=/);
  });

  it("carries the machine region and lets ARM own execution", async () => {
    await dispatchRunCommand(CONFIG, [target({ azureRegion: "westeurope" })], SCRIPTS, OPTS);
    const body = JSON.parse(armCalls()[0].init.body);
    expect(body.location).toBe("westeurope");
    // asyncExecution keeps the PUT fast — we report dispatch, not results.
    expect(body.properties.asyncExecution).toBe(true);
  });
});

describe("partial failure", () => {
  it("keeps going after one machine fails and reports every target", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (isTokenUrl(url)) return TOKEN_OK;
      if (String(url).includes("/machines/bad/")) return res(403, { error: { message: "denied" } });
      return res(201, { id: "rc" });
    });

    const out = await dispatchRunCommand(
      CONFIG,
      [target({ name: "ok1" }), target({ name: "bad" }), target({ name: "ok2" })],
      SCRIPTS, OPTS,
    );

    expect(out).toHaveLength(3);
    expect(out.filter((r) => r.dispatched).map((r) => r.name).sort()).toEqual(["ok1", "ok2"]);
    const bad = out.find((r) => r.name === "bad")!;
    expect(bad.dispatched).toBe(false);
    expect(bad.error).toMatch(/denied|403/i);
  });

  it("returns results in target order so the caller can zip them back", async () => {
    const targets = ["a", "b", "c"].map((n) => target({ name: n }));
    const out = await dispatchRunCommand(CONFIG, targets, SCRIPTS, OPTS);
    expect(out.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("handles an empty target list without calling out", async () => {
    const out = await dispatchRunCommand(CONFIG, [], SCRIPTS, OPTS);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("listRunCommandTargets — the picker's roster", () => {
  const SUB = "11111111-2222-3333-4444-555555555555";

  /**
   * A machine as ARM returns it — NOT the DiscoveredArcMachine shape. The OS
   * type is at properties.osType, the region at `location`, the id at `id`;
   * nothing sits at the top-level keys ArcRunCommandTarget reads.
   */
  function rawMachine(name: string, osType: string, over: Record<string, unknown> = {}) {
    return {
      id: `/subscriptions/${SUB}/resourceGroups/rg-app/providers/Microsoft.HybridCompute/machines/${name}`,
      name,
      type: "microsoft.hybridcompute/machines",
      location: "eastus",
      tags: {},
      properties: { osType, osName: osType.toLowerCase(), status: "Connected", displayName: name },
      ...over,
    };
  }

  /** Route ARM reads by path; `arg` decides what Resource Graph answers. */
  function routeArm(arg: () => ReturnType<typeof res>, rpRows: unknown[] = []) {
    fetchMock.mockImplementation(async (url: string) => {
      if (isTokenUrl(url)) return TOKEN_OK;
      const path = new URL(String(url)).pathname;
      if (path === "/subscriptions") return res(200, { value: [{ subscriptionId: SUB, displayName: "Prod" }] });
      if (path.endsWith("/providers/Microsoft.ResourceGraph/resources")) return arg();
      if (path.endsWith("/providers/Microsoft.HybridCompute/machines")) return res(200, { value: rpRows });
      return res(201, { id: "rc" });
    });
  }

  it("reads OS, id and region out of raw Resource Graph rows", async () => {
    // ARG projects subscriptionId + resourceGroup as their own columns.
    routeArm(() => res(200, { data: [
      rawMachine("SRV1", "Windows", { subscriptionId: SUB, resourceGroup: "rg-app" }),
      rawMachine("web1", "Linux", { subscriptionId: SUB, resourceGroup: "rg-app" }),
    ] }));

    const roster = await listRunCommandTargets(CONFIG);

    expect(roster).toHaveLength(2);
    expect(roster[0]).toEqual({
      armId: `/subscriptions/${SUB}/resourcegroups/rg-app/providers/microsoft.hybridcompute/machines/srv1`,
      name: "SRV1",
      subscriptionId: SUB,
      resourceGroup: "rg-app",
      azureRegion: "eastus",
      osType: "windows",
      status: "Connected",
    });
    expect(roster[1].osType).toBe("linux");
  });

  it("normalizes the per-subscription fallback rows too when Resource Graph is unavailable", async () => {
    routeArm(
      () => res(403, { error: { code: "AuthorizationFailed", message: "no ARG" } }),
      // Resource-provider rows carry no subscriptionId / resourceGroup columns —
      // both come from the id.
      [rawMachine("db1", "Linux")],
    );

    const roster = await listRunCommandTargets(CONFIG);

    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      name: "db1", subscriptionId: SUB, resourceGroup: "rg-app", azureRegion: "eastus", osType: "linux",
    });
  });

  it("produces targets dispatchRunCommand will actually run, not skip", async () => {
    routeArm(() => res(200, { data: [rawMachine("SRV1", "Windows", { subscriptionId: SUB, resourceGroup: "rg-app" })] }));

    const roster = await listRunCommandTargets(CONFIG);
    const out = await dispatchRunCommand(CONFIG, roster, SCRIPTS, OPTS);

    expect(out[0]).toMatchObject({ name: "SRV1", dispatched: true });
    expect(out[0].skipped).toBeUndefined();
    const put = armCalls().find((c) => c.init?.method === "PUT")!;
    expect(JSON.parse(put.init.body).properties.source.script).toBe("WIN-BODY");
  });
});
