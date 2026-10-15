/**
 * tests/integration/alertPathGraph.test.ts
 *
 * The Path Monitor alert email's `{path.graph}` block, end to end against real
 * traceroute rows and the real rasterizer: one image for an ungrouped alert, up
 * to four for a grouped one, a server-run check read under the server subject,
 * and nothing at all when traceroute is off or no trace exists yet.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { buildPathGraphBlocks, pathGraphCid } from "../../src/services/alertPathGraphService.js";
import { POLARIS_SERVER_SUBJECT } from "../../src/services/pathCheckIngestService.js";
import type { AlertMember } from "../../src/services/notificationTypes.js";

const d = dbDescribe;
const NAME = "path-graph-email-test";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function wipe(): Promise<void> {
  const checks = await prisma.pathCheck.findMany({ where: { name: { startsWith: NAME } }, select: { id: true } });
  await prisma.assetPathCheckTraceroute.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } });
  await prisma.pathCheck.deleteMany({ where: { name: { startsWith: NAME } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: NAME } } });
}

async function seedHost(name: string): Promise<string> {
  const a = await prisma.asset.create({
    data: { hostname: `${NAME}-${name}`, status: "active", monitored: true, assetType: "workstation" } as never,
    select: { id: true },
  });
  return a.id;
}

async function seedCheck(name: string, traceroute: Record<string, unknown> = { enabled: true }): Promise<string> {
  const c = await prisma.pathCheck.create({
    data: { name: `${NAME} ${name}`, kind: "https", target: "https://erp.example.test", intervalSec: 300, traceroute, scope: {}, definitionSha256: "0".repeat(64) } as never,
    select: { id: true },
  });
  return c.id;
}

async function seedTrace(subject: string, checkId: string, complete = true): Promise<void> {
  await prisma.assetPathCheckTraceroute.create({
    data: {
      assetId: subject, checkId, destinationIp: "192.0.2.10", complete, hopCount: 3, pathHash: "x",
      hops: [
        { ttl: 1, ip: "10.0.0.1", rttMs: [1, 1, 1] },
        { ttl: 2, ip: "10.1.0.1", rttMs: [5, 6, 5] },
        ...(complete ? [{ ttl: 3, ip: "192.0.2.10", rttMs: [70, 72, 71] }] : []),
      ],
    } as never,
  });
}

const member = (key: string, over: Partial<AlertMember>): AlertMember =>
  ({ key, label: key, ruleId: "r1", ruleName: "ERP path", severity: "warning", joinedAt: "", ...over });

d("the {path.graph} email block", () => {
  beforeEach(wipe);
  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("draws the one path of an ungrouped alert as an inline PNG", async () => {
    const host = await seedHost("pc-01");
    const check = await seedCheck("erp");
    await seedTrace(host, check);
    const out = await buildPathGraphBlocks({ assetId: host, dimension: check, metric: "pathOk", ruleId: null, members: null, testRun: false });
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0]!.cid).toBe(pathGraphCid(0));
    expect(out.attachments[0]!.content.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    expect(out.html).toContain(`cid:${pathGraphCid(0)}`);
    expect(out.html).toContain(">Path<");
    expect(out.text).toContain(`${NAME} erp — from ${NAME}-pc-01`);
  });

  it("draws one path per device on a grouped alert, at most four", async () => {
    const check = await seedCheck("erp");
    const hosts: string[] = [];
    for (const n of ["a", "b", "c", "d", "e"]) {
      const h = await seedHost(n);
      hosts.push(h);
      await seedTrace(h, check, n !== "a");
    }
    const members = hosts.map((h) => member(check, { assetId: h }));
    const out = await buildPathGraphBlocks({ assetId: hosts[0]!, dimension: check, metric: "pathOk", ruleId: "r1", members, testRun: false });
    expect(out.attachments).toHaveLength(4);
    expect(out.html).toContain("Paths (4)");
    expect(out.text).toContain("✕ not reached");
  });

  it("reads a server-run check under the server subject", async () => {
    const check = await seedCheck("server");
    await seedTrace(POLARIS_SERVER_SUBJECT, check);
    const out = await buildPathGraphBlocks({ assetId: null, dimension: check, metric: "pathLatencyMs", ruleId: null, members: null, testRun: false });
    expect(out.attachments).toHaveLength(1);
    expect(out.text).toContain("from Polaris server");
  });

  it("renders away when traceroute is off, before the first trace, and off path alerts", async () => {
    const host = await seedHost("pc-02");
    const off = await seedCheck("off", { enabled: false });
    await seedTrace(host, off);
    const fresh = await seedCheck("fresh");
    for (const n of [
      { dimension: off, metric: "pathOk" },
      { dimension: fresh, metric: "pathOk" },
      { dimension: off, metric: "cpuPct" },
    ]) {
      const out = await buildPathGraphBlocks({ assetId: host, ruleId: null, members: null, testRun: false, ...n });
      expect(out).toEqual({ html: "", text: "", attachments: [] });
    }
  });
});
