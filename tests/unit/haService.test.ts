/**
 * tests/unit/haService.test.ts — own suite for haService (CQ-T010).
 *
 * Complements, does not repeat:
 *   - haEnrollmentService.test.ts — mocks this module wholesale
 *   - ssrfOutboundCallers.test.ts — measureRtt never dials loopback / metadata
 *     (rule 110)
 *   - capacityService.test.ts — the ha_patroni_rest_cleartext reason built on
 *     refreshPatroniScheme
 *   - the pure advisory maths live in utils/haAdvisories and their own suite
 *
 * Unreached until now: the `ha.config` Setting (defaults, merge of a partial
 * row), redactHaConfig keeping every sealed secret out of a response,
 * detectLocalAddresses, enableHa's topology validation, the install-shape
 * refusal, and its "re-enable never rotates" contract (credentials, CA, sync
 * keys and learned host keys survive), disableHa keeping the material,
 * issueEtcdCert's SAN list and its failure wording, getClusterStatus over the
 * loopback Patroni API (HTTPS first, HTTP fallback, Patroni 3 "master" and 4
 * "primary", nofailover disarming failover, never a throw), refreshPatroniScheme's
 * 10-minute probe cache and cleartext verdict (rule 117), and computeAdvisories
 * with no addresses entered. openssl, rpm, the Patroni API and the keygen are
 * mocks — nothing is spawned, dialled or written outside a temp dir.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";

const h = vi.hoisted(() => ({
  execFile: vi.fn(),
  fetch: vi.fn(),
  networkInterfaces: vi.fn(),
  assessInstallShape: vi.fn(),
  keygen: vi.fn(),
  cnf: "" as string,
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return { ...real, default: { ...real, execFile: h.execFile }, execFile: h.execFile };
});
vi.mock("node:os", async (orig) => {
  const real = await orig<typeof import("node:os")>();
  return { ...real, default: { ...real, networkInterfaces: h.networkInterfaces }, networkInterfaces: h.networkInterfaces };
});
vi.mock("undici", async (orig) => ({
  ...(await orig<object>()),
  fetch: h.fetch,
  Agent: class { constructor(public opts: unknown) {} },
}));
vi.mock("../../src/utils/haAdvisories.js", async (orig) => ({
  ...(await orig<object>()),
  assessInstallShape: h.assessInstallShape,
}));
vi.mock("../../src/utils/sshKeygen.js", async (orig) => ({
  ...(await orig<object>()),
  generateEd25519Keypair: h.keygen,
}));
vi.mock("../../src/utils/proxyMode.js", () => ({ isProxyMode: () => true }));
vi.mock("../../src/utils/dbConnections.js", async (orig) => ({
  ...(await orig<object>()),
  isPgbouncerMode: () => false,
  getDirectDatabaseUrl: () => null,
}));
vi.mock("../../src/utils/publicUrl.js", async (orig) => ({
  ...(await orig<object>()),
  getPublicApiBaseUrl: () => "https://polaris.example",
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  getHaConfig,
  invalidateHaConfigCache,
  redactHaConfig,
  detectLocalAddresses,
  enableHa,
  disableHa,
  issueEtcdCert,
  getClusterStatus,
  refreshPatroniScheme,
  computeAdvisories,
  measureRtt,
  type HaConfig,
  type EnableHaInput,
} from "../../src/services/haService.js";

let stored: unknown;

/** openssl / id / rpm / chronyc, as execFile callbacks. openssl writes its -out file. */
function fakeExec(opts: { failOpenssl?: boolean } = {}) {
  h.execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    if (cmd === "openssl") {
      if (opts.failOpenssl) return cb(new Error("openssl: not found"));
      const cfgAt = args.indexOf("-config");
      if (cfgAt >= 0) h.cnf = readFileSync(args[cfgAt + 1], "utf8");
      const outAt = args.indexOf("-out");
      if (outAt >= 0) writeFileSync(args[outAt + 1], `${args[0]}-output`);
      return cb(null, { stdout: "", stderr: "" });
    }
    if (cmd === "id") return cb(null, { stdout: "991\n", stderr: "" });
    if (cmd === "rpm") return cb(null, { stdout: "2.17.2 ", stderr: "" });
    if (cmd === "chronyc") return cb(null, { stdout: "Ref time : x\nSystem time     : 0.000001 seconds fast\n", stderr: "" });
    return cb(new Error(`unexpected ${cmd}`));
  });
}

const realPlatform = process.platform;
function setPlatform(p: string) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

const INPUT: EnableHaInput = {
  witnessPlacement: "third-site",
  primary: { name: "pg-a", clusterAddr: "10.0.0.1" },
  standby: { name: "pg-b", clusterAddr: "10.1.0.1", extraSans: ["pg-b.corp", "bad san!", ""] },
  witness: { name: "wit", clusterAddr: "witness.example.net", reachPrimaryVia: "203.0.113.5" },
};

beforeEach(() => {
  resetDbStub();
  invalidateHaConfigCache();
  stored = undefined;
  h.cnf = "";
  for (const f of [h.execFile, h.fetch, h.networkInterfaces, h.assessInstallShape, h.keygen]) f.mockReset();
  stubbed(prisma.setting.findUnique).mockImplementation(async ({ where }: { where: { key: string } }) =>
    where.key === "ha.config" && stored !== undefined ? { key: "ha.config", value: stored } : null);
  stubbed(prisma.setting.upsert).mockImplementation(async ({ create }: { create: { value: unknown } }) => {
    stored = create.value;
    return create;
  });
  stubbed(prisma.$queryRaw).mockRejectedValue(new Error("no grant"));
  h.assessInstallShape.mockReturnValue({ supported: true, reasons: [] });
  let n = 0;
  h.keygen.mockImplementation(() => ({ publicKey: `ssh-ed25519 PUB${++n}`, privateKey: `PRIV${n}` }));
  h.networkInterfaces.mockReturnValue({});
  fakeExec();
});

afterEach(() => setPlatform(realPlatform));

// ─── config ─────────────────────────────────────────────────────────────────

describe("getHaConfig", () => {
  it("is disabled with the shipped defaults when nothing is stored", async () => {
    expect(await getHaConfig()).toEqual({
      enabled: false, scope: "polaris", witnessPlacement: "third-site", nodes: {},
      gslb: { monitorIntervalSec: 5, monitorRetries: 3, dnsTtlSec: 5 },
    });
  });

  it("merges a partial row over the defaults, gslb field by field", async () => {
    stored = { enabled: true, gslb: { dnsTtlSec: 30 } };
    const c = await getHaConfig();
    expect(c).toMatchObject({ enabled: true, scope: "polaris", nodes: {} });
    expect(c.gslb).toEqual({ monitorIntervalSec: 5, monitorRetries: 3, dnsTtlSec: 30 });
  });
});

describe("redactHaConfig", () => {
  it("reports that the secrets exist without ever including them", () => {
    const cfg: HaConfig = {
      enabled: true, scope: "s", witnessPlacement: "third-site", nodes: {},
      gslb: { monitorIntervalSec: 5, monitorRetries: 3, dnsTtlSec: 5 },
      etcdCa: { cert: "CERT", privateKey: "CA-SECRET" },
      credentials: {
        superuser: { password: "P1" }, replicator: { password: "P2" }, rewind: { password: "P3" },
        restapi: { password: "P4" }, cluster: { token: "TOKEN" },
      },
      sync: { primary: { publicKey: "pub1", privateKey: "SYNC1" }, standby: { publicKey: "pub2", privateKey: "SYNC2" } },
    };
    const r = redactHaConfig(cfg);
    expect(r).toMatchObject({ etcdCaPresent: true, credentialsPresent: true, syncKeysPresent: true });
    const json = JSON.stringify(r);
    for (const secret of ["CA-SECRET", "P1", "P2", "P3", "P4", "TOKEN", "SYNC1", "SYNC2", "CERT", "pub1"]) expect(json).not.toContain(secret);
  });

  it("says absent when they are", async () => {
    expect(redactHaConfig(await getHaConfig())).toMatchObject({ etcdCaPresent: false, credentialsPresent: false, syncKeysPresent: false });
  });
});

describe("detectLocalAddresses", () => {
  it("lists every non-internal IPv4 and IPv6 address with its interface", () => {
    h.networkInterfaces.mockReturnValue({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      eth0: [{ address: "10.0.0.5", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
      weird: [{ address: "x", family: "AF_PACKET", internal: false }],
      down: undefined,
    });
    expect(detectLocalAddresses()).toEqual([
      { address: "10.0.0.5", family: "IPv4", iface: "eth0" },
      { address: "fe80::1", family: "IPv6", iface: "eth0" },
    ]);
  });
});

describe("measureRtt — no target", () => {
  it("is null for an empty address without dialing", async () => {
    expect(await measureRtt("")).toBeNull();
  });
});

// ─── enable / disable ───────────────────────────────────────────────────────

describe("enableHa — validation", () => {
  it.each([
    ["a bad member name", { ...INPUT, primary: { name: "-bad", clusterAddr: "10.0.0.1" } }, /member name/],
    ["duplicate names", { ...INPUT, standby: { name: "pg-a", clusterAddr: "10.1.0.1" } }, /names must differ/],
    ["a bad address", { ...INPUT, witness: { name: "wit", clusterAddr: "has space" } }, /cluster address/],
    ["duplicate addresses", { ...INPUT, standby: { name: "pg-b", clusterAddr: "10.0.0.1" } }, /addresses must differ/],
  ])("refuses %s before touching anything", async (_l, input, msg) => {
    await expect(enableHa(input as EnableHaInput, "admin")).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(msg) });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it("refuses an install shape the HA tooling does not cover, naming why", async () => {
    h.assessInstallShape.mockReturnValue({ supported: false, reasons: ["nginx must terminate TLS."] });
    await expect(enableHa(INPUT, "admin")).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining("nginx must terminate TLS.") });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });
});

describe("enableHa — first enable and re-enable", () => {
  it("mints credentials, the etcd CA and two sync keypairs, and stores the topology", async () => {
    setPlatform("linux");
    const cfg = await enableHa({ ...INPUT, scope: "  plant  " }, "admin");
    expect(cfg).toMatchObject({ enabled: true, scope: "plant", enabledBy: "admin", witnessPlacement: "third-site" });
    expect(cfg.nodes.standby).toEqual({ name: "pg-b", clusterAddr: "10.1.0.1", extraSans: ["pg-b.corp"], reachPrimaryVia: undefined, sshHostKeys: [] });
    expect(cfg.nodes.witness!.reachPrimaryVia).toBe("203.0.113.5");
    const pw = Object.values(cfg.credentials!).map((c) => ("password" in c ? c.password : c.token));
    expect(new Set(pw).size).toBe(5);
    for (const p of pw) expect(p).toMatch(/^[A-Za-z0-9]{20,28}$/); // no YAML / shell / libpq quoting characters
    expect(cfg.etcdCa).toEqual({ cert: "req-output", privateKey: "genrsa-output" });
    expect(cfg.sync).toEqual({
      primary: { publicKey: "ssh-ed25519 PUB1", privateKey: "PRIV1" },
      standby: { publicKey: "ssh-ed25519 PUB2", privateKey: "PRIV2" },
    });
    // Host facts read on Linux; the PostgreSQL paths are the fallbacks.
    expect(cfg.hostFacts).toMatchObject({ pgBinDir: "/usr/pgsql-17/bin", pgdata: "/var/lib/pgsql/17/data", polarisUid: 991, tsdbVersion: "2.17.2" });
    expect(stored).toEqual(cfg);
  });

  it("re-enabling never rotates what the nodes already hold", async () => {
    setPlatform("linux");
    const first = await enableHa(INPUT, "admin");
    (stored as HaConfig).nodes.standby!.sshHostKeys = ["SHA256:abc"];
    invalidateHaConfigCache();
    h.execFile.mockClear();
    h.keygen.mockClear();
    const again = await enableHa({ ...INPUT, gslb: { dnsTtlSec: 60 } }, "other");
    expect(again.credentials).toEqual(first.credentials);
    expect(again.etcdCa).toEqual(first.etcdCa);
    expect(again.sync).toEqual(first.sync);
    expect(again.nodes.standby!.sshHostKeys).toEqual(["SHA256:abc"]);
    expect(again.gslb).toEqual({ monitorIntervalSec: 5, monitorRetries: 3, dnsTtlSec: 60 });
    expect(again.enabledBy).toBe("other");
    expect(h.keygen).not.toHaveBeenCalled();
    expect(h.execFile.mock.calls.filter((c) => c[0] === "openssl")).toEqual([]);
  });

  it("an openssl failure is a 500 that tells the operator what to check, and nothing is saved", async () => {
    setPlatform("linux");
    fakeExec({ failOpenssl: true });
    await expect(enableHa(INPUT, "admin")).rejects.toMatchObject({ httpStatus: 500, message: expect.stringContaining("is openssl installed") });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });
});

describe("disableHa", () => {
  it("turns HA off and keeps every credential, the CA and the keys", async () => {
    setPlatform("linux");
    const on = await enableHa(INPUT, "admin");
    invalidateHaConfigCache();
    const off = await disableHa("admin");
    expect(off.enabled).toBe(false);
    expect(off.credentials).toEqual(on.credentials);
    expect(off.etcdCa).toEqual(on.etcdCa);
    expect((stored as HaConfig).enabled).toBe(false);
  });
});

describe("issueEtcdCert", () => {
  const withCa = { etcdCa: { cert: "CA", privateKey: "KEY" } } as HaConfig;

  it("refuses without a CA", async () => {
    await expect(issueEtcdCert({} as HaConfig, "pg-a", "10.0.0.1")).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("issues a server+client certificate whose SANs cover every address it is dialled on", async () => {
    const r = await issueEtcdCert(withCa, "pg-b", "10.1.0.1", ["pg-b.corp", "", "192.0.2.7"]);
    expect(r).toEqual({ cert: "x509-output", privateKey: "genrsa-output" });
    expect(h.cnf).toContain("CN = pg-b");
    expect(h.cnf).toContain("extendedKeyUsage = serverAuth, clientAuth");
    expect(h.cnf).toContain("IP.1 = 10.1.0.1");
    expect(h.cnf).toContain("DNS.1 = pg-b.corp");
    expect(h.cnf).toContain("IP.2 = 192.0.2.7");
    expect(h.cnf).toContain("IP.3 = 127.0.0.1");
    expect(h.cnf).toContain("DNS.2 = localhost");
  });

  it("a signing failure is a 500 that points at the log", async () => {
    fakeExec({ failOpenssl: true });
    await expect(issueEtcdCert(withCa, "pg-b", "10.1.0.1")).rejects.toMatchObject({ httpStatus: 500, message: expect.stringContaining("server log") });
  });
});

// ─── Patroni ────────────────────────────────────────────────────────────────

const resp = (status: number, body: unknown = "") => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

describe("refreshPatroniScheme (rule 117) — module state, so these run in order", () => {
  afterEach(() => vi.useRealTimers());

  it("an HTTPS failure falls back to HTTP and reads as cleartext", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    h.fetch.mockImplementation(async (url: string) => {
      if (url.startsWith("https://")) throw new TypeError("fetch failed");
      return resp(200, { members: [] });
    });
    expect(await refreshPatroniScheme()).toBe(true);
    expect(h.fetch.mock.calls.map((c) => c[0])).toEqual(["https://127.0.0.1:8008/cluster", "http://127.0.0.1:8008/cluster"]);
  });

  it("probes at most every ten minutes, reporting the last answer in between", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T00:05:00Z"));
    h.fetch.mockResolvedValue(resp(200, { members: [] }));
    expect(await refreshPatroniScheme()).toBe(true);
    expect(h.fetch).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-06-01T00:10:01Z"));
    expect(await refreshPatroniScheme()).toBe(false); // now answering over TLS
    expect(h.fetch.mock.calls[0][1]).toHaveProperty("dispatcher");
  });
});

describe("getClusterStatus", () => {
  it("reads members, finds the leader under either Patroni naming, and the local role", async () => {
    h.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/cluster")) {
        return resp(200, { members: [
          { name: "pg-a", role: "master", state: "running", host: "10.0.0.1", lag: 0, timeline: 4 },
          { name: "pg-b", role: "replica", state: "streaming", lag: 1024, tags: {} },
          {},
        ] });
      }
      return resp(503);
    });
    const s = await getClusterStatus();
    expect(s.available).toBe(true);
    expect(s.localRole).toBe("replica");
    expect(s.members[0]).toEqual({ name: "pg-a", role: "master", state: "running", host: "10.0.0.1", lagBytes: 0, timeline: 4, tags: {} });
    expect(s.members[2]).toMatchObject({ name: "?", role: "?", lagBytes: null, timeline: null });
    expect(s.automaticFailover).toBe(true);
  });

  it("a replica tagged nofailover means failover is not armed", async () => {
    h.fetch.mockImplementation(async (url: string) => url.endsWith("/cluster")
      ? resp(200, { members: [{ name: "a", role: "primary" }, { name: "b", role: "replica", tags: { nofailover: true } }] })
      : resp(200));
    const s = await getClusterStatus();
    expect(s).toMatchObject({ automaticFailover: false, localRole: "primary" });
  });

  it("a lone member is not a failover pair", async () => {
    h.fetch.mockImplementation(async (url: string) => url.endsWith("/cluster") ? resp(200, { members: [{ name: "a", role: "leader" }] }) : resp(418));
    expect(await getClusterStatus()).toMatchObject({ automaticFailover: false, localRole: "unknown" });
  });

  it("a non-2xx answer or no Patroni at all is reported, never thrown", async () => {
    h.fetch.mockResolvedValue(resp(503));
    expect(await getClusterStatus()).toEqual({ available: false, members: [], localRole: "unknown", automaticFailover: false, reason: "Patroni answered 503" });
    h.fetch.mockRejectedValue(new TypeError("ECONNREFUSED"));
    expect(await getClusterStatus()).toMatchObject({ available: false, reason: "Patroni is not reachable on this host" });
  });

  it("a timeout says so", async () => {
    h.fetch.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect((await getClusterStatus()).reason).toBe("Patroni did not answer in 2.5 s");
  });
});

// ─── advisories ─────────────────────────────────────────────────────────────

describe("computeAdvisories", () => {
  it("with no addresses entered, asks for them instead of measuring, and reports the host", async () => {
    h.networkInterfaces.mockReturnValue({ eth0: [{ address: "10.0.0.5", family: "IPv4", internal: false }] });
    stubbed(prisma.$queryRaw).mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("").includes("pg_database_size") ? [{ size: 5_000_000n }] : Promise.reject(new Error("no grant")));
    const a = await computeAdvisories();
    expect(a.latency.standby).toEqual({ level: "unknown", detail: expect.stringContaining("standby's cluster address") });
    expect(a.latency.witness).toEqual({ level: "unknown", detail: expect.stringContaining("witness address") });
    expect(a.host).toMatchObject({ dbSizeBytes: 5_000_000, publicUrl: "https://polaris.example", localAddresses: [{ address: "10.0.0.5", family: "IPv4", iface: "eth0" }] });
    expect(h.assessInstallShape).toHaveBeenCalledWith(expect.objectContaining({ proxyMode: true, pgbouncer: false, localPgdata: false }));
  });

  it("a gslb override reaches the RTO estimate", async () => {
    const base = await computeAdvisories();
    const slow = await computeAdvisories({ gslb: { monitorIntervalSec: 60, monitorRetries: 5, dnsTtlSec: 300 } });
    expect(slow.rto.estimate.maxSec).toBeGreaterThan(base.rto.estimate.maxSec);
  });
});
