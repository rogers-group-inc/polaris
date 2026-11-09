/**
 * scripts/seed-topology-from-export.ts — recreate an operator's anonymised
 * Device Map export (Export › Layout data, format `polaris-topology-layout/1`)
 * as real rows, so the dev app's Device Map draws the same site.
 *
 * Run:  node --env-file=.env --import tsx/esm scripts/seed-topology-from-export.ts <export.json>
 *   or: npm run mock:topology-export -- <export.json>
 *
 * DEV ONLY — refuses NODE_ENV=production. Idempotent: every asset it creates is
 * a Fortinet firewall / switch / AP whose hostname starts with "EXP-", and each
 * run deletes those (cascading their LLDP / interface rows) before recreating.
 *
 * What each exported thing becomes (see topologyGraphService.buildSiteTopology
 * and buildTopologyElements in public/js/topology-render.js for the readers):
 *
 *   device          → one Asset, hostname "EXP-<id>". The FortiGate carries
 *                     fortinetTopology.deviceName (its FortiManager device name,
 *                     deliberately NOT its hostname); every switch / AP stamps
 *                     controllerFortigate = that device name + controllerSerial,
 *                     which is how controllerStampWhereOr finds the site's
 *                     children (fortinetParentKey.ts).
 *   health          → monitored / monitorStatus (the FortiGate's health is read
 *                     from its last 10 AssetMonitorSample rows instead, so ten
 *                     samples are written for it).
 *   boxes           → Asset.description location codes (a:/b:/f:/r:/jb:) with
 *                     the box ids as names, deepest box + its parent chain, so
 *                     the hulls nest exactly as exported.
 *   verifiedUplink  → FortiGate→switch controller edge, made "verified" by an
 *                     LLDP row ON THE FORTIGATE matched to that switch (the
 *                     fgSiblingNeighbors rule); the row's localIfName / portId
 *                     fill both label halves, the switch's uplinkPhysicalPort
 *                     its own half. Unverified FG→switch edges (every other
 *                     switch's FortiLink controller edge) are dropped client-side.
 *   apLink          → AP fortinetTopology.parentSwitch = the switch's hostname
 *                     + parentPort; the server draws switch→AP labelled
 *                     "<parentPort> ↔ lan1". An AP with no link gets no
 *                     parentSwitch → the server's FG→AP fallback edge, which the
 *                     client never draws.
 *   iface           → ONE LLDP row on side A (localIfName = A's port, portId =
 *                     B's port, matched to B). lldpOnlySwitchLinks turns it into
 *                     an interface edge, and the physical-member expansion keeps
 *                     it a single line. The server may orient it either way.
 *   speed           → AssetInterface current-state rows (ifType "physical",
 *                     speedBps, operStatus up) on each named port of the link;
 *                     the client colours a link by the slower end. "unknown"
 *                     writes no row.
 *
 * TIME WINDOW: lldpOnlySwitchLinks and the per-edge interface details only
 * read rows seen in the last HOUR, so every row is stamped NOW. After an hour
 * the 43 switch↔switch links (and every link speed) disappear from the map —
 * re-run this script to refresh them. The monitor job may also start probing
 * these fake 10.250.x.x addresses and flip their health.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const HOST_PREFIX = "EXP-";

// ── Export shape (only what the seeder reads) ─────────────────────────────
type Role = "fortigate" | "fortiswitch" | "fortiap";
type BoxKind = "area" | "building" | "floor" | "room" | "jb";
interface ExportDevice { id: string; role: Role; health: string | null; boxes: string[] }
interface ExportBox { id: string; kind: BoxKind; parent: string | null }
interface ExportLink { a: string; b: string; flags: string[]; ports?: string; speed?: string; speedBps?: number }
export interface TopologyExport {
  format: string;
  devices: ExportDevice[];
  boxes: ExportBox[];
  links: ExportLink[];
}

// ── Seed plan: plain rows, DB-free so it can be unit-tested ───────────────
export interface PlannedAsset {
  id: string;
  exportId: string;
  hostname: string;
  serialNumber: string;
  assetType: "firewall" | "switch" | "access_point";
  manufacturer: "Fortinet";
  model: string;
  ipAddress: string;
  status: "active" | "maintenance";
  monitored: boolean;
  monitorStatus: string | null;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  fortinetTopology: Record<string, unknown>;
}
export interface PlannedLldp {
  assetId: string;
  localIfName: string;
  chassisIdSubtype: string;
  chassisId: string;
  portIdSubtype: string | null;
  portId: string | null;
  systemName: string;
  matchedAssetId: string;
  source: "fortios";
}
export interface PlannedInterface { assetId: string; ifName: string; speedBps: bigint }
export interface PlannedSample { assetId: string; success: boolean }
export interface SeedPlan {
  assets: PlannedAsset[];
  lldp: PlannedLldp[];
  interfaces: PlannedInterface[];
  samples: PlannedSample[];
  warnings: string[];
}

const KIND_KEY: Record<BoxKind, string> = { area: "a", building: "b", floor: "f", room: "r", jb: "jb" };
const KIND_ORDER: BoxKind[] = ["area", "building", "floor", "room", "jb"];
const SPEED_BPS: Record<string, number> = {
  "10g": 10e9, "5g": 5e9, "2g5": 2.5e9, "1g": 1e9, "100m": 1e8, "10m": 1e7,
};

/** "a ↔ b" → [a|null, b|null]; "unknown"/empty halves are null. */
function splitPorts(ports: string | undefined): [string | null, string | null] {
  const parts = String(ports || "").split("↔").map((p) => p.trim());
  const clean = (p: string | undefined) => (p && p.toLowerCase() !== "unknown" && p.toLowerCase() !== "fortilink" ? p : null);
  return [clean(parts[0]), clean(parts[1])];
}

/** A device's location codes: its deepest box plus that box's parent chain. */
export function locationDescription(boxIds: string[], boxes: Map<string, ExportBox>, warn: (m: string) => void): string | null {
  const known = boxIds.filter((id) => boxes.has(id));
  if (known.length === 0) return null;
  // Deepest = the box no other listed box sits under.
  const ancestorsOf = (id: string): string[] => {
    const out: string[] = [];
    for (let cur = boxes.get(id)?.parent ?? null, guard = 0; cur && guard < 10; cur = boxes.get(cur)?.parent ?? null, guard++) out.push(cur);
    return out;
  };
  let deepest = known[0];
  for (const id of known) if (ancestorsOf(id).length > ancestorsOf(deepest).length) deepest = id;
  const chain = [deepest, ...ancestorsOf(deepest)];
  for (const id of known) if (!chain.includes(id)) warn(`box ${id} is not on the parent chain of ${deepest}; ignored`);
  const byKind = new Map<BoxKind, string>();
  for (const id of chain) {
    const b = boxes.get(id)!;
    if (byKind.has(b.kind)) warn(`two ${b.kind} boxes on one chain (${byKind.get(b.kind)}, ${id})`);
    else byKind.set(b.kind, id);
  }
  return KIND_ORDER.filter((k) => byKind.has(k)).map((k) => `${KIND_KEY[k]}:${byKind.get(k)}`).join(" ");
}

function healthToMonitor(health: string | null): { monitored: boolean; monitorStatus: string | null; status: "active" | "maintenance" } {
  switch (health) {
    case "up":          return { monitored: true, monitorStatus: "up", status: "active" };
    case "degraded":    return { monitored: true, monitorStatus: "warning", status: "active" };
    case "down":        return { monitored: true, monitorStatus: "down", status: "active" };
    case "passive":     return { monitored: true, monitorStatus: "passive", status: "active" };
    case "maintenance": return { monitored: true, monitorStatus: "up", status: "maintenance" };
    case "unmonitored": return { monitored: false, monitorStatus: null, status: "active" };
    default:            return { monitored: true, monitorStatus: null, status: "active" }; // grey "unknown"
  }
}

const num = (id: string, fallback: number): number => {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : fallback;
};

export function buildSeedPlan(exp: TopologyExport): SeedPlan {
  if (exp.format !== "polaris-topology-layout/1") throw new Error(`unsupported export format: ${exp.format}`);
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const boxes = new Map(exp.boxes.map((b) => [b.id, b]));

  const gates = exp.devices.filter((d) => d.role === "fortigate");
  if (gates.length !== 1) throw new Error(`expected exactly one fortigate in the export, found ${gates.length}`);
  const gate = gates[0];
  const fgSerial = `FG100FTKEXP${String(num(gate.id, 1)).padStart(5, "0")}`;
  // The FortiManager device name — what children stamp in controllerFortigate.
  // Deliberately different from the hostname (fortinetParentKey.ts).
  const fgDeviceName = `${HOST_PREFIX}${gate.id}-FMG`;

  // Per-AP uplink from apLink edges (switch side = the switch).
  const roleOf = new Map(exp.devices.map((d) => [d.id, d.role]));
  const apUplink = new Map<string, { sw: string; port: string | null }>();
  for (const l of exp.links) {
    if (!l.flags.includes("apLink")) continue;
    const [pa, pb] = splitPorts(l.ports);
    const [sw, ap, swPort] = roleOf.get(l.a) === "fortiswitch" ? [l.a, l.b, pa] : [l.b, l.a, pb];
    if (roleOf.get(sw) !== "fortiswitch" || roleOf.get(ap) !== "fortiap") { warn(`apLink ${l.a}–${l.b} is not switch–AP; skipped`); continue; }
    if (apUplink.has(ap)) warn(`AP ${ap} has more than one apLink; only the first is seeded`);
    else apUplink.set(ap, { sw, port: swPort });
  }
  const verified = exp.links.filter((l) => l.flags.includes("verifiedUplink"));
  const uplinkPortOfSwitch = new Map<string, string | null>();
  for (const l of verified) {
    const [pa, pb] = splitPorts(l.ports);
    if (l.a === gate.id) uplinkPortOfSwitch.set(l.b, pb);
    else uplinkPortOfSwitch.set(l.a, pa);
  }

  const assets: PlannedAsset[] = [];
  const idOf = new Map<string, string>();
  const counters = { fortiswitch: 0, fortiap: 0 };
  for (const d of exp.devices) {
    const id = randomUUID();
    idOf.set(d.id, id);
    const n = num(d.id, 0);
    const mon = healthToMonitor(d.health);
    const description = locationDescription(d.boxes || [], boxes, (m) => warn(`${d.id}: ${m}`));
    const hostname = HOST_PREFIX + d.id;
    if (d.role === "fortigate") {
      assets.push({
        id, exportId: d.id, hostname, serialNumber: fgSerial, assetType: "firewall", manufacturer: "Fortinet",
        model: "FortiGate-100F", ipAddress: "10.250.0.1", ...mon, description,
        latitude: 36.1627, longitude: -86.7816,
        fortinetTopology: { role: "fortigate", deviceName: fgDeviceName },
      });
      continue;
    }
    const controller = { controllerFortigate: fgDeviceName, controllerSerial: fgSerial };
    if (d.role === "fortiswitch") {
      counters.fortiswitch++;
      const uplinkPort = uplinkPortOfSwitch.get(d.id);
      assets.push({
        id, exportId: d.id, hostname, serialNumber: `S148FPTFEXP${String(n).padStart(5, "0")}`, assetType: "switch",
        manufacturer: "Fortinet", model: "FortiSwitch-148F-FPOE", ipAddress: `10.250.1.${(n % 250) + 1}`, ...mon,
        description, latitude: null, longitude: null,
        fortinetTopology: {
          role: "fortiswitch", ...controller, uplinkInterface: "fortilink",
          ...(uplinkPort ? { uplinkPhysicalPort: uplinkPort } : {}),
        },
      });
    } else if (d.role === "fortiap") {
      counters.fortiap++;
      const up = apUplink.get(d.id);
      assets.push({
        id, exportId: d.id, hostname, serialNumber: `FP231FTFEXP${String(n).padStart(5, "0")}`, assetType: "access_point",
        manufacturer: "Fortinet", model: "FortiAP-231F", ipAddress: `10.250.2.${(n % 250) + 1}`, ...mon,
        description, latitude: null, longitude: null,
        fortinetTopology: up
          ? { role: "fortiap", ...controller, parentSwitch: HOST_PREFIX + up.sw, parentPort: up.port, peerSource: "lldp", meshUplink: "ethernet" }
          : { role: "fortiap", ...controller },
      });
    } else {
      warn(`device ${d.id} has role ${String(d.role)}; skipped`);
      idOf.delete(d.id);
    }
  }

  const fakeChassis = (exportId: string): string => {
    const h = [...exportId].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7);
    const hex = h.toString(16).padStart(8, "0");
    return `02:e5:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}`;
  };
  const lldp: PlannedLldp[] = [];
  const lldpRow = (from: string, fromPort: string, to: string, toPort: string | null): PlannedLldp => ({
    assetId: idOf.get(from)!,
    localIfName: fromPort,
    chassisIdSubtype: "macAddress",
    chassisId: fakeChassis(to),
    portIdSubtype: toPort ? "interfaceName" : null,
    portId: toPort,
    systemName: HOST_PREFIX + to,
    matchedAssetId: idOf.get(to)!,
    source: "fortios",
  });
  const interfaces = new Map<string, PlannedInterface>();
  const addIf = (dev: string, port: string | null, bps: number | null) => {
    if (!port || !bps || !idOf.has(dev)) return;
    const k = `${dev}|${port}`;
    if (interfaces.has(k)) { warn(`port ${k} is on more than one link; first speed kept`); return; }
    interfaces.set(k, { assetId: idOf.get(dev)!, ifName: port, speedBps: BigInt(Math.round(bps)) });
  };

  for (const l of exp.links) {
    if (!idOf.has(l.a) || !idOf.has(l.b)) { warn(`link ${l.a}–${l.b} names an unknown device; skipped`); continue; }
    let [pa, pb] = splitPorts(l.ports);
    const bps = l.speedBps ?? SPEED_BPS[String(l.speed || "").toLowerCase()] ?? null;
    if (l.flags.includes("verifiedUplink")) {
      const [sw, swPort, gatePort] = l.a === gate.id ? [l.b, pb, pa] : [l.a, pa, pb];
      // The FortiGate's own LLDP row naming the switch: verifies the uplink and
      // carries the gate-side port (localIfName) + switch-side port (portId).
      lldp.push(lldpRow(gate.id, gatePort ?? "fortilink", sw, swPort));
      addIf(gate.id, gatePort, bps);
      addIf(sw, swPort, bps);
    } else if (l.flags.includes("apLink")) {
      const sw = roleOf.get(l.a) === "fortiswitch" ? l.a : l.b;
      const ap = sw === l.a ? l.b : l.a;
      addIf(sw, sw === l.a ? pa : pb, bps);
      addIf(ap, sw === l.a ? pb ?? "lan1" : pa ?? "lan1", bps);
    } else if (l.flags.includes("iface") || l.flags.includes("lldp")) {
      if (roleOf.get(l.a) !== "fortiswitch" || roleOf.get(l.b) !== "fortiswitch") {
        warn(`iface link ${l.a}–${l.b} is not switch–switch; not reproducible, skipped`);
        continue;
      }
      let [a, b] = [l.a, l.b];
      if (!pa && pb) { [a, b, pa, pb] = [l.b, l.a, pb, pa]; } // the row must sit on a side with a known port
      if (!pa) warn(`iface link ${l.a}–${l.b} has no known port on either side; drawn as "unknown ↔ unknown"`);
      lldp.push(lldpRow(a, pa ?? "", b, pb));
      addIf(a, pa, bps);
      addIf(b, pb, bps);
    } else {
      warn(`link ${l.a}–${l.b} flags [${l.flags.join(",")}] not reproducible; skipped`);
    }
  }

  // The FortiGate's map colour comes from its last 10 response-time samples.
  const fgMon = healthToMonitor(gate.health);
  const fgId = idOf.get(gate.id)!;
  // up / passive → all succeed, degraded → half fail, down → all fail,
  // unknown / unmonitored → none.
  const samples: PlannedSample[] = !fgMon.monitored || fgMon.monitorStatus === null
    ? []
    : Array.from({ length: 10 }, (_, i) => ({
        assetId: fgId,
        success: fgMon.monitorStatus === "down" ? false : fgMon.monitorStatus === "warning" ? i % 2 === 0 : true,
      }));

  return { assets, lldp, interfaces: [...interfaces.values()], samples, warnings };
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed an exported topology in production.");
    process.exit(1);
  }
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node --env-file=.env --import tsx/esm scripts/seed-topology-from-export.ts <export.json>");
    process.exit(2);
  }
  const plan = buildSeedPlan(JSON.parse(readFileSync(file, "utf8")) as TopologyExport);
  const { prisma } = await import("../src/db.js");
  try {
    const now = new Date();
    const acquired = new Date(now.getTime() - 90 * 24 * 3600 * 1000);

    // ── Wipe the previous run (cascades LLDP / interface rows) ─────────────
    const prior = await prisma.asset.findMany({
      where: {
        hostname: { startsWith: HOST_PREFIX },
        manufacturer: "Fortinet",
        assetType: { in: ["firewall", "switch", "access_point"] },
      },
      select: { id: true },
    });
    const priorIds = prior.map((a) => a.id);
    if (priorIds.length > 0) {
      // Monitor samples are a hypertable with no FK — delete them explicitly.
      await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: priorIds } } });
      await prisma.asset.deleteMany({ where: { id: { in: priorIds } } });
    }

    // ── Recreate ──────────────────────────────────────────────────────────
    await prisma.asset.createMany({
      data: plan.assets.map(({ exportId: _e, ...a }) => ({
        ...a,
        acquiredAt: acquired,
        lastSeen: now,
        monitorStatusChangedAt: a.monitorStatus ? now : null,
        fortinetTopology: a.fortinetTopology as object,
      })),
    });
    await prisma.assetLldpNeighbor.createMany({ data: plan.lldp.map((r) => ({ ...r, firstSeen: now, lastSeen: now })) });
    await prisma.assetInterface.createMany({
      data: plan.interfaces.map((r) => ({ ...r, ifType: "physical", adminStatus: "up", operStatus: "up", duplex: "full", firstSeen: now, lastSeen: now })),
    });
    await prisma.assetMonitorSample.createMany({
      data: plan.samples.map((s, i) => ({
        ...s, timestamp: new Date(now.getTime() - i * 60_000), responseTimeMs: s.success ? 2 : null,
        probeKind: "primary", error: s.success ? null : "timeout",
      })),
    });

    const fg = plan.assets.find((a) => a.assetType === "firewall")!;
    const count = (t: string) => plan.assets.filter((a) => a.assetType === t).length;
    console.log(`Seeded export topology (wiped ${priorIds.length} prior ${HOST_PREFIX}* assets):`);
    console.log(`  FortiGate    ${fg.hostname} (${fg.id}), FMG device name ${String(fg.fortinetTopology.deviceName)}`);
    console.log(`  FortiSwitch  ${count("switch")}   FortiAP  ${count("access_point")}`);
    console.log(`  LLDP rows    ${plan.lldp.length}   interface rows ${plan.interfaces.length}   FG samples ${plan.samples.length}`);
    for (const w of plan.warnings) console.log(`  warning: ${w}`);
    console.log("");
    console.log("Caveat: switch↔switch links and link speeds come from rows the Device Map only reads for 1 HOUR");
    console.log("(stamped now). Re-run this script to refresh them. Open the Device Map and pick the EXP- site.");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
