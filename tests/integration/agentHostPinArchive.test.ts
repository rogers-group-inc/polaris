/**
 * tests/integration/agentHostPinArchive.test.ts
 *
 * Business rule 123 against a real database: decommissioning an agent host
 * moves the SSH host key / TLS certificate pins on its addresses into its
 * ManagedAgent archive (an address another live asset answers to is kept),
 * reactivating it writes them back verbatim (never over a key pinned there
 * since), the reconcile pass does the same for status writers that are not the
 * PUT route, and an agent that checks in while archived raises ONE
 * `decommissioned-agent-checkin` conflict whose Accept reactivates + reinstates
 * and whose Reject silences that decommission.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import {
  archiveAgentHostPins,
  reinstateAgentHostPins,
  raiseDecommissionedAgentConflict,
  reconcileAgentHostPins,
  previewDecommissionPins,
  hostPinsForAsset,
  DECOMMISSIONED_AGENT_COLLISION_REASON,
} from "../../src/services/agentHostPinService.js";
import { acceptConflict, rejectConflict, loadPendingConflict } from "../../src/services/conflictResolutionService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PREFIX = "decom-pin-test-";
const IP = "10.123.0.10";
const SSH_FP = "SHA256:originalHostKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TLS_FP = "A".repeat(64);

let assetId = "";
let agentId = "";

async function wipe(): Promise<void> {
  await prisma.managedAgent.deleteMany({ where: { asset: { hostname: { startsWith: PREFIX } } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PREFIX } } });
  await prisma.sshHostKey.deleteMany({ where: { host: { startsWith: "10.123." } } });
  await prisma.tlsCertPin.deleteMany({ where: { host: { startsWith: "10.123." } } });
}

async function checkinConflicts(status?: "pending" | "accepted" | "rejected") {
  return prisma.conflict.findMany({
    where: {
      assetId,
      proposedAssetFields: { path: ["collisionReason"], equals: DECOMMISSIONED_AGENT_COLLISION_REASON },
      ...(status ? { status } : {}),
    },
  });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await wipe();
  try { await prisma.$disconnect(); } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await wipe();
  const asset = await prisma.asset.create({
    data: { hostname: `${PREFIX}host`, assetType: "server", status: "active", ipAddress: IP },
  });
  assetId = asset.id;
  const agent = await prisma.managedAgent.create({
    data: {
      assetId, osPlatform: "windows", arch: "amd64", installStatus: "active", installedBy: "test",
      serverCertFingerprint: "sha256:" + "e".repeat(64), additionalServerCertFingerprints: [],
    },
  });
  agentId = agent.id;
  await prisma.sshHostKey.create({ data: { host: IP, port: 22, keyType: "ssh-ed25519", fingerprint: SSH_FP } });
  await prisma.tlsCertPin.create({ data: { host: IP, port: 5986, fingerprint: TLS_FP, subject: "CN=host" } });
});

d("agent host pin archive (business rule 123)", () => {
  it("archives the SSH and TLS pins on decommission and reinstates them verbatim", async () => {
    const preview = await previewDecommissionPins([assetId]);
    expect(preview).toHaveLength(1);
    expect(preview[0].pins.map((p) => p.kind).sort()).toEqual(["ssh", "tls"]);

    const archived = await archiveAgentHostPins(assetId, "tester");
    expect(archived?.archived).toHaveLength(2);
    expect(await prisma.sshHostKey.count({ where: { host: IP } })).toBe(0);
    expect(await prisma.tlsCertPin.count({ where: { host: IP } })).toBe(0);
    const row = await prisma.managedAgent.findUnique({ where: { id: agentId } });
    expect(row?.hostPinsArchivedAt).not.toBeNull();

    // Idempotent: a second archive is a no-op.
    expect(await archiveAgentHostPins(assetId, "tester")).toBeNull();

    const view = await hostPinsForAsset(assetId);
    expect(view.live).toHaveLength(0);
    expect(view.archived?.pins).toHaveLength(2);

    const back = await reinstateAgentHostPins(assetId, "tester");
    expect(back?.restored).toHaveLength(2);
    expect(back?.skipped).toHaveLength(0);
    const ssh = await prisma.sshHostKey.findUnique({ where: { host_port: { host: IP, port: 22 } } });
    expect(ssh?.fingerprint).toBe(SSH_FP);
    expect(ssh?.keyType).toBe("ssh-ed25519");
    const tls = await prisma.tlsCertPin.findUnique({ where: { host_port: { host: IP, port: 5986 } } });
    expect(tls?.fingerprint).toBe(TLS_FP);
    expect((await prisma.managedAgent.findUnique({ where: { id: agentId } }))?.hostPinsArchivedAt).toBeNull();
    expect(await prisma.event.count({ where: { action: "asset.host_pins_archived", resourceId: assetId } })).toBe(1);
    expect(await prisma.event.count({ where: { action: "asset.host_pins_reinstated", resourceId: assetId } })).toBe(1);
  });

  it("leaves a pin on an address another live asset answers to", async () => {
    await prisma.asset.create({ data: { hostname: `${PREFIX}other`, assetType: "server", status: "active", ipAddress: IP } });
    const archived = await archiveAgentHostPins(assetId, "tester");
    expect(archived?.archived).toHaveLength(0);
    expect(archived?.leftShared).toEqual([IP]);
    expect(await prisma.sshHostKey.count({ where: { host: IP } })).toBe(1);
  });

  it("never overwrites a key pinned on the endpoint while the asset was away", async () => {
    await archiveAgentHostPins(assetId, "tester");
    await prisma.sshHostKey.create({ data: { host: IP, port: 22, keyType: "ssh-ed25519", fingerprint: "SHA256:aNewMachine" } });
    const back = await reinstateAgentHostPins(assetId, "tester");
    expect(back?.skipped.map((s) => s.kind)).toEqual(["ssh"]);
    expect(back?.restored.map((s) => s.kind)).toEqual(["tls"]);
    const ssh = await prisma.sshHostKey.findUnique({ where: { host_port: { host: IP, port: 22 } } });
    expect(ssh?.fingerprint).toBe("SHA256:aNewMachine");
  });

  it("the reconcile pass archives for a status written outside the PUT route, and reinstates on return", async () => {
    await prisma.asset.updateMany({ where: { id: assetId }, data: { status: "decommissioned" } });
    await reconcileAgentHostPins();
    expect((await prisma.managedAgent.findUnique({ where: { id: agentId } }))?.hostPinsArchivedAt).not.toBeNull();
    expect(await prisma.sshHostKey.count({ where: { host: IP } })).toBe(0);

    await prisma.asset.updateMany({ where: { id: assetId }, data: { status: "active" } });
    await reconcileAgentHostPins();
    expect((await prisma.managedAgent.findUnique({ where: { id: agentId } }))?.hostPinsArchivedAt).toBeNull();
    expect(await prisma.sshHostKey.count({ where: { host: IP } })).toBe(1);
  });

  it("a check-in while archived raises one conflict; Accept reactivates and reinstates", async () => {
    // Not decommissioned → nothing to ask.
    await raiseDecommissionedAgentConflict(agentId, "10.123.0.10");
    expect(await checkinConflicts()).toHaveLength(0);

    await prisma.asset.update({ where: { id: assetId }, data: { status: "decommissioned" } });
    await archiveAgentHostPins(assetId, "tester");
    await raiseDecommissionedAgentConflict(agentId, "10.123.0.10");
    await raiseDecommissionedAgentConflict(agentId, "10.123.0.11"); // refreshes, never duplicates
    const pending = await checkinConflicts("pending");
    expect(pending).toHaveLength(1);
    expect((pending[0].proposedAssetFields as Record<string, unknown>).checkinIp).toBe("10.123.0.11");
    expect(((pending[0].proposedAssetFields as Record<string, unknown>).pins as unknown[]).length).toBe(2);

    await acceptConflict(await loadPendingConflict(pending[0].id), "tester");
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    expect(asset?.status).toBe("active");
    expect(await prisma.sshHostKey.count({ where: { host: IP } })).toBe(1);
    expect(await checkinConflicts("accepted")).toHaveLength(1);
  });

  it("Reject keeps it decommissioned and silences that decommission only", async () => {
    await prisma.asset.update({ where: { id: assetId }, data: { status: "decommissioned" } });
    await archiveAgentHostPins(assetId, "tester");
    await raiseDecommissionedAgentConflict(agentId, null);
    const [c] = await checkinConflicts("pending");
    await rejectConflict(await loadPendingConflict(c.id), "tester");
    expect((await prisma.asset.findUnique({ where: { id: assetId } }))?.status).toBe("decommissioned");

    await raiseDecommissionedAgentConflict(agentId, null);
    expect(await checkinConflicts("pending")).toHaveLength(0);

    // Reactivated and decommissioned again → a new archive, so it may ask again.
    await reinstateAgentHostPins(assetId, "tester");
    await archiveAgentHostPins(assetId, "tester");
    await raiseDecommissionedAgentConflict(agentId, null);
    expect(await checkinConflicts("pending")).toHaveLength(1);
  });

  it("the asset PUT route archives on decommission and reinstates on return", async () => {
    const { agent, csrf } = await authedAgent(app);
    const down = await agent.put(`/api/v1/assets/${assetId}`).set("X-CSRF-Token", csrf).send({ status: "decommissioned" });
    expect(down.status).toBe(200);
    expect(await prisma.sshHostKey.count({ where: { host: IP } })).toBe(0);

    const pins = await agent.get(`/api/v1/assets/${assetId}/host-pins`);
    expect(pins.status).toBe(200);
    expect(pins.body.archived.pins).toHaveLength(2);

    const up = await agent.put(`/api/v1/assets/${assetId}`).set("X-CSRF-Token", csrf).send({ status: "active" });
    expect(up.status).toBe(200);
    expect(await prisma.sshHostKey.count({ where: { host: IP } })).toBe(1);
    expect(await prisma.tlsCertPin.count({ where: { host: IP } })).toBe(1);
  });

  it("the decommission preview names agent hosts only", async () => {
    const plain = await prisma.asset.create({ data: { hostname: `${PREFIX}plain`, assetType: "server", status: "active", ipAddress: "10.123.0.20" } });
    const { agent, csrf } = await authedAgent(app);
    const r = await agent.post("/api/v1/assets/decommission-preview").set("X-CSRF-Token", csrf).send({ ids: [assetId, plain.id] });
    expect(r.status).toBe(200);
    expect(r.body.assets.map((a: { assetId: string }) => a.assetId)).toEqual([assetId]);
  });
});
