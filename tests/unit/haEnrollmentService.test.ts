/**
 * tests/unit/haEnrollmentService.test.ts — the generated bootstrap script.
 *
 * The script is what an operator copies onto a machine and runs as root, so
 * two properties matter more than anything else about this feature and are
 * pinned here: it carries the one-use token and NOTHING else sensitive, and it
 * pins the certificate and the address rather than trusting DNS and the
 * system trust store.
 *
 * The database-backed halves of this service (mint, register, approve, claim)
 * are exercised end to end in tests/integration/haEnroll.test.ts, where a real
 * unique index and a real conditional update can actually prove single use.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const CONFIG = {
  enabled: true,
  scope: "polaris",
  witnessPlacement: "third-site" as const,
  nodes: {
    primary: { name: "polaris-a", clusterAddr: "10.10.1.5", extraSans: [], sshHostKeys: [] },
    standby: { name: "polaris-b", clusterAddr: "10.20.1.5", extraSans: [], sshHostKeys: [] },
    witness: { name: "witness", clusterAddr: "198.51.100.7", extraSans: [], reachPrimaryVia: "203.0.113.9", sshHostKeys: [] },
  },
  gslb: { monitorIntervalSec: 5, monitorRetries: 3, dnsTtlSec: 5 },
  credentials: {
    superuser: { password: "sup3r" },
    replicator: { password: "r3pl" },
    rewind: { password: "rew1nd" },
    restapi: { password: "r3st" },
    cluster: { token: "clustertoken" },
  },
  etcdCa: { cert: "CA-CERT", privateKey: "CA-KEY" },
  sync: {
    primary: { publicKey: "ssh-ed25519 AAAAprimary", privateKey: "PRIV-A" },
    standby: { publicKey: "ssh-ed25519 AAAAstandby", privateKey: "PRIV-B" },
  },
  hostFacts: {
    pgBinDir: "/usr/pgsql-15/bin",
    pgdata: "/var/lib/pgsql/15/data",
    tsdbVersion: "2.17.2",
    nodeMajor: "v20.11.0",
    polarisUid: 987,
  },
};

vi.mock("../../src/services/haService.js", () => ({
  getHaConfig: vi.fn(async () => CONFIG),
  invalidateHaConfigCache: vi.fn(),
  issueEtcdCert: vi.fn(async () => ({ cert: "NODE-CERT", privateKey: "NODE-KEY" })),
}));

vi.mock("../../src/services/certInfo.js", () => ({
  getServerCertFingerprint: vi.fn(() => "sha256:" + "ab".repeat(32)),
}));

vi.mock("../../src/utils/publicUrl.js", () => ({
  getPublicApiBaseUrl: vi.fn(() => "https://polaris.example.com"),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    haEnrollment: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    setting: { upsert: vi.fn(), findUnique: vi.fn() },
  },
  prismaBase: {},
}));

const { renderNodeScript, renderTeardownScript, buildNodeBundle, TOKEN_TTL_MS, APPROVAL_WINDOW_MS } =
  await import("../../src/services/haEnrollmentService.js");
const { listTar, readTarEntry } = await import("../../src/utils/tarWriter.js");
const { gunzipSync } = await import("node:zlib");

describe("renderNodeScript", () => {
  it("embeds the token, the public host and the role", async () => {
    const { script, filename } = await renderNodeScript("standby", "polaris_TESTTOKEN123");
    expect(filename).toBe("polaris-ha-standby.sh");
    expect(script).toContain("polaris_TESTTOKEN123");
    expect(script).toContain("polaris.example.com");
    expect(script).toContain("NODE_ROLE='standby'");
    expect(script).toContain("NODE_NAME='polaris-b'");
  });

  it("pins the certificate agents pin", async () => {
    const { script } = await renderNodeScript("standby", "polaris_x");
    expect(script).toContain("CERT_PIN='sha256:" + "ab".repeat(32) + "'");
    expect(script).toContain("--pinnedpubkey");
  });

  it("forces the connection to this node's own route to the primary", async () => {
    // The witness reaches the primary through a public address; the standby
    // uses the primary's cluster address. Both keep the public hostname in
    // SNI so nginx routes them and the pin still matches.
    const witness = await renderNodeScript("witness", "polaris_x");
    expect(witness.script).toContain("POLARIS_ADDR='203.0.113.9'");
    expect(witness.script).toContain("--resolve");

    const standby = await renderNodeScript("standby", "polaris_x");
    expect(standby.script).toContain("POLARIS_ADDR='10.10.1.5'");
  });

  it("carries NO secret other than the token", async () => {
    const { script } = await renderNodeScript("standby", "polaris_x");
    for (const secret of ["r3pl", "rew1nd", "sup3r", "r3st", "clustertoken", "CA-KEY", "PRIV-A", "PRIV-B"]) {
      expect(script).not.toContain(secret);
    }
  });

  it("waits for approval instead of assuming the bundle is available", async () => {
    const { script } = await renderNodeScript("primary", "polaris_x");
    expect(script).toMatch(/APPROVE this node/);
    expect(script).toContain('"ready":true');
    expect(script).toContain("rejected");
    expect(script).toContain("expired");
  });

  it("is a root-only, fail-fast bash script", async () => {
    const { script } = await renderNodeScript("primary", "polaris_x");
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("[[ $EUID -eq 0 ]] || die 'must run as root'");
  });

  it("deletes nothing silently — it tells the operator the bundle holds keys", async () => {
    const { script } = await renderNodeScript("standby", "polaris_x");
    expect(script).toMatch(/private keys/);
  });

  it("gives the token a day and the approval wait half an hour", () => {
    expect(TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(APPROVAL_WINDOW_MS).toBe(30 * 60 * 1000);
  });
});

describe("renderTeardownScript", () => {
  it("requires a typed confirmation and unmasks the stock PostgreSQL unit", async () => {
    const { script, filename } = await renderTeardownScript();
    expect(filename).toBe("polaris-ha-teardown.sh");
    expect(script).toContain("TEARDOWN");
    expect(script).toContain("systemctl unmask postgresql-15");
    expect(script).toContain("/var/lib/pgsql/15/data");
  });

  it("restores the configuration Patroni took over", async () => {
    const { script } = await renderTeardownScript();
    expect(script).toContain("postgresql.base.conf");
    expect(script).toContain("pg_hba.conf.polaris-pre-ha");
    expect(script).toContain("10-ha.conf");
  });

  it("says plainly that the database files are untouched", async () => {
    const { script } = await renderTeardownScript();
    expect(script).toMatch(/database FILES\s+are untouched|does not convert one/);
  });
});

describe("buildNodeBundle", () => {
  const originalCertPath = process.env.POLARIS_PROXY_CERT_PATH;

  beforeEach(() => {
    delete process.env.POLARIS_PROXY_CERT_PATH;
  });
  afterEach(() => {
    if (originalCertPath === undefined) delete process.env.POLARIS_PROXY_CERT_PATH;
    else process.env.POLARIS_PROXY_CERT_PATH = originalCertPath;
  });

  it("gives the witness etcd material and nothing else", async () => {
    const gz = await buildNodeBundle(CONFIG as never, "witness");
    const names = listTar(gunzipSync(gz)).map((e) => e.name);
    expect(names).toContain("etcd/ca.crt");
    expect(names).toContain("etcd/witness.crt");
    expect(names).toContain("etcd/witness.key");
    expect(names).toContain("etcd/etcd.conf");
    // The load-bearing assertion: a vote does not get the application's keys.
    expect(names.some((n) => n.startsWith("app/"))).toBe(false);
    expect(names.some((n) => n.startsWith("patroni/"))).toBe(false);
    expect(names.some((n) => n.startsWith("sync/"))).toBe(false);
  });

  it("renders an etcd config naming all three members and mutual TLS", async () => {
    const gz = await buildNodeBundle(CONFIG as never, "witness");
    const conf = readTarEntry(gunzipSync(gz), "etcd/etcd.conf")!.toString("utf8");
    expect(conf).toContain("polaris-a=https://10.10.1.5:2380");
    expect(conf).toContain("polaris-b=https://10.20.1.5:2380");
    expect(conf).toContain("witness=https://198.51.100.7:2380");
    expect(conf).toContain("ETCD_CLIENT_CERT_AUTH=true");
    expect(conf).toContain("ETCD_PEER_CLIENT_CERT_AUTH=true");
    expect(conf).toContain("ETCD_NAME=witness");
    // WAN tuning, not the LAN defaults.
    expect(conf).toContain("ETCD_ELECTION_TIMEOUT=2500");
  });

  it("keeps the witness's private key owner-only in the archive", async () => {
    const gz = await buildNodeBundle(CONFIG as never, "witness");
    const entries = listTar(gunzipSync(gz));
    expect(entries.find((e) => e.name === "etcd/witness.key")!.mode).toBe(0o600);
    expect(entries.find((e) => e.name === "etcd/ca.crt")!.mode).toBe(0o644);
  });

  it("refuses a database node's bundle when no proxy certificate is configured", async () => {
    // The standby must serve the identical leaf agents pin; without it the
    // bundle would build a node the fleet rejects.
    await expect(buildNodeBundle(CONFIG as never, "standby")).rejects.toThrow(/POLARIS_PROXY_CERT_PATH/);
  });

  it("refuses to build anything when HA is not enabled", async () => {
    await expect(buildNodeBundle({ ...CONFIG, enabled: false } as never, "witness")).rejects.toThrow(/not enabled/);
  });

  it("refuses when the configuration is missing its generated material", async () => {
    await expect(buildNodeBundle({ ...CONFIG, etcdCa: undefined } as never, "witness")).rejects.toThrow(/incomplete/);
    await expect(buildNodeBundle({ ...CONFIG, credentials: undefined } as never, "witness")).rejects.toThrow(/incomplete/);
  });

  it("carries a manifest the bootstrap script can assert parity against", async () => {
    const gz = await buildNodeBundle(CONFIG as never, "witness");
    const manifest = JSON.parse(readTarEntry(gunzipSync(gz), "MANIFEST.json")!.toString("utf8"));
    expect(manifest.role).toBe("witness");
    expect(manifest.scope).toBe("polaris");
    expect(manifest.expect.nodeMajor).toBe("v20.11.0");
    expect(manifest.expect.tsdbVersion).toBe("2.17.2");
    expect(manifest.expect.polarisUid).toBe(987);
  });
});
