/**
 * prisma/seed-lab-fortigates.ts — register a lab's standalone FortiGates as
 * Polaris integrations on a LOCAL dev database.
 *
 * Why this exists: most of the Fortinet surface cannot be exercised against a
 * seeded database. Discovery phases, the per-subnet Discover pass, VIP and
 * DHCP reconciliation, SD-WAN, description sync and every push pathway only
 * tell you anything when a real FortiOS device is answering. This turns a
 * one-line-per-gate inventory into the integration rows those paths need, so
 * a fresh dev stack is pointed at the lab in seconds rather than through five
 * passes of the Add Integration modal.
 *
 * ── The credentials are NOT in this repository ────────────────────────────────
 * Polaris is public. The inventory this reads lives OUTSIDE the checkout —
 * `~/.polaris/lab-devices.json` by default, or wherever `POLARIS_LAB_DEVICES`
 * points. Git cannot stage a path outside its own tree, so there is no
 * .gitignore rule to forget and no `git add -A` that can pick it up. Copy
 * `prisma/lab-devices.example.json` to that location and fill it in.
 *
 * Tokens are never printed. Everything this logs is masked.
 *
 * ── Refuses anything that is not obviously a dev database ─────────────────────
 * It writes integration rows that a discovery run will immediately act on, so
 * pointing it at a production database would register lab gates in a live
 * install. The guard is the DATABASE_URL host: loopback only, unless
 * POLARIS_LAB_ALLOW_REMOTE_DB=1 says otherwise.
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm prisma/seed-lab-fortigates.ts
 *   node --env-file=.env --import tsx/esm prisma/seed-lab-fortigates.ts --probe
 *   node --env-file=.env --import tsx/esm prisma/seed-lab-fortigates.ts --probe-only
 *
 *   --probe       reach each gate after writing it and report FortiOS version
 *   --probe-only  reach each gate and write nothing
 *   --prune       remove lab integrations whose name is no longer in the file
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/db.js";
import { testConnection } from "../src/services/fortigateService.js";

// ─── Inventory file ─────────────────────────────────────────────────────────

interface LabDevice {
  name: string;
  host: string;
  apiToken: string;
  role?: string;
  port?: number;
  apiUser?: string;
  vdom?: string;
  verifySsl?: boolean;
  pushReservations?: boolean;
  autoReserveFortinetInfra?: boolean;
  adoptDiscoveredMac?: boolean;
  syncDescriptions?: boolean;
  pullSdwan?: boolean;
}

interface LabInventory {
  defaults?: Partial<LabDevice>;
  devices: LabDevice[];
}

/**
 * Every integration this script manages is named `<prefix><device name>`, and
 * it will only ever update or delete a row whose name starts with the prefix.
 * Without that, a re-run could overwrite an operator's own integration that
 * happened to share a name.
 */
const NAME_PREFIX = "lab-";

function inventoryPath(): string {
  return process.env.POLARIS_LAB_DEVICES || join(homedir(), ".polaris", "lab-devices.json");
}

function loadInventory(): LabInventory {
  const path = inventoryPath();
  if (!existsSync(path)) {
    throw new Error(
      `No lab inventory at ${path}.\n` +
        `Copy prisma/lab-devices.example.json there and fill in the real values, ` +
        `or set POLARIS_LAB_DEVICES to point at it.\n` +
        `Keep it OUTSIDE this checkout — it holds live API tokens and this repository is public.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as LabInventory;
  if (!Array.isArray(raw.devices) || raw.devices.length === 0) {
    throw new Error(`${path} has no "devices" array.`);
  }
  for (const d of raw.devices) {
    if (!d.name || !d.host || !d.apiToken) {
      throw new Error(`Every device needs name, host and apiToken — check ${JSON.stringify(d.name ?? d.host ?? "(unnamed)")}.`);
    }
  }
  return raw;
}

/** Last four characters only, so a log line can be matched to a device without carrying the secret. */
function maskToken(token: string): string {
  return token.length <= 4 ? "****" : `…${token.slice(-4)}`;
}

// ─── Safety ─────────────────────────────────────────────────────────────────

/**
 * Refuse a database that is not plainly local.
 *
 * Writing here is not a read-only rehearsal: a discovery run will pick these
 * integrations up on its next cycle and start reaching the gates. On a
 * production install that means lab devices appearing in a real inventory.
 */
function assertLocalDatabase(): void {
  if (process.env.POLARIS_LAB_ALLOW_REMOTE_DB === "1") {
    console.warn("! POLARIS_LAB_ALLOW_REMOTE_DB=1 — skipping the local-database check.");
    return;
  }
  const url = process.env.DATABASE_URL || "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is missing or unparseable — refusing to run.");
  }
  const local = ["127.0.0.1", "localhost", "::1", "postgres"];
  if (!local.includes(host)) {
    throw new Error(
      `DATABASE_URL points at "${host}", which is not a local dev database.\n` +
        `This registers live lab gates that discovery will immediately start polling.\n` +
        `Set POLARIS_LAB_ALLOW_REMOTE_DB=1 only if you are certain.`,
    );
  }
}

// ─── Config shape ───────────────────────────────────────────────────────────

/**
 * The stored `Integration.config` for one gate.
 *
 * `apiToken` is sealed at rest by the Prisma extension in src/db.ts (it is in
 * the `configSecretFields` name union), so this writes plaintext and what
 * lands in the column is encrypted whenever POLARIS_SECRET_KEY is set.
 *
 * Every write toggle defaults OFF. These are real devices: a discovery cycle
 * that starts pushing DHCP reservations or rewriting interface descriptions
 * because a seed script turned something on by default is not a lab accident
 * anyone wants. Turn one on, in the inventory file, for the run that tests it.
 */
function buildConfig(d: LabDevice, defaults: Partial<LabDevice>): Record<string, unknown> {
  const pick = <K extends keyof LabDevice>(key: K, fallback: NonNullable<LabDevice[K]>): NonNullable<LabDevice[K]> =>
    (d[key] ?? defaults[key] ?? fallback) as NonNullable<LabDevice[K]>;

  return {
    host: d.host,
    port: pick("port", 443),
    apiUser: pick("apiUser", "polaris_api"),
    apiToken: d.apiToken,
    vdom: pick("vdom", "root"),
    // Lab gates present self-signed certificates. Production integrations
    // default to verify-ON; this is an explicit lab-only relaxation, and it is
    // per-device so one gate with a real certificate can keep verification.
    verifySsl: pick("verifySsl", false),
    pushReservations: pick("pushReservations", false),
    autoReserveFortinetInfra: pick("autoReserveFortinetInfra", false),
    adoptDiscoveredMac: pick("adoptDiscoveredMac", false),
    syncDescriptions: pick("syncDescriptions", false),
    pullSdwan: pick("pullSdwan", false),
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const probeOnly = args.has("--probe-only");
  const probe = probeOnly || args.has("--probe");
  const prune = args.has("--prune");

  const inventory = loadInventory();
  const defaults = inventory.defaults ?? {};
  console.log(`Lab inventory: ${inventoryPath()} (${inventory.devices.length} device(s))\n`);

  if (!probeOnly) assertLocalDatabase();

  const seen: string[] = [];

  for (const d of inventory.devices) {
    const name = `${NAME_PREFIX}${d.name}`;
    const config = buildConfig(d, defaults);
    seen.push(name);

    if (!probeOnly) {
      const existing = await prisma.integration.findFirst({ where: { name }, select: { id: true } });
      if (existing) {
        await prisma.integration.update({
          where: { id: existing.id },
          data: { type: "fortigate", config: config as never, enabled: true },
        });
        console.log(`~ ${name.padEnd(12)} ${d.host.padEnd(16)} token ${maskToken(d.apiToken)}  (updated)`);
      } else {
        await prisma.integration.create({
          data: { name, type: "fortigate", config: config as never, enabled: true },
        });
        console.log(`+ ${name.padEnd(12)} ${d.host.padEnd(16)} token ${maskToken(d.apiToken)}  (created)`);
      }
    }

    if (probe) {
      const res = await testConnection({
        host: d.host,
        port: config.port as number,
        apiUser: config.apiUser as string,
        apiToken: d.apiToken,
        vdom: config.vdom as string,
        verifySsl: config.verifySsl as boolean,
      } as never);
      console.log(`  ${res.ok ? "OK  " : "FAIL"} ${name} — ${res.message}`);
    }
  }

  if (prune && !probeOnly) {
    const stale = await prisma.integration.findMany({
      where: { name: { startsWith: NAME_PREFIX }, NOT: { name: { in: seen } } },
      select: { id: true, name: true },
    });
    for (const s of stale) {
      await prisma.integration.delete({ where: { id: s.id } });
      console.log(`- ${s.name} (pruned — no longer in the inventory)`);
    }
    if (stale.length === 0) console.log("\nNothing to prune.");
  }

  if (!probeOnly) {
    console.log(
      `\nDone. Run a discovery cycle from Integrations, or restart the app and wait for the ` +
        `scheduled one, to populate subnets and assets.`,
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(`\n${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
