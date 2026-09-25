/**
 * scripts/seed-firmware-mock.ts — seed a dev database with the devices,
 * device login and firmware images that make Server Settings → Repository and
 * the asset Firmware card demonstrable end to end (business rule 87), against
 * the fake devices `scripts/mock-firmware-devices.mjs` serves.
 *
 * What it seeds (idempotent — prior rows by these hostnames / names are removed):
 *   - three Fortinet assets on loopback aliases the mock devices listen on:
 *       MOCK-S108FF-1   switch        S108FFTF23000001  127.0.0.2  7.4.3 build0542
 *       MOCK-S548DF-1   switch        S548DFTF19000001  127.0.0.3  7.4.3 build0542
 *       MOCK-FAP231K-1  access_point  FP231KTF24000001  127.0.0.4  FP231K-v7.4.3-build0542
 *     plus a "FortiSwitch S224EN" model node that only holds an image — no
 *     asset carries it, so the orphaned-node flag has something to show.
 *   - an `http` credential "Mock device login" in form mode (admin / admin),
 *     bound at the manufacturer level (Fortinet).
 *   - firmware images, two per model node (a primary and a backup), written
 *     as tiny fake .out files whose 512-byte header carries a real-shaped
 *     token, registered through the same service the upload route uses —
 *     so they rotate, hash and warn exactly as an operator's upload would.
 *
 * MUST run inside the running app container (FIRMWARE_DIR is under its
 * POLARIS_STATE_DIR), e.g.
 *   podman exec polaris-<slug>_app_1 sh -c \
 *     'cd /app && node --env-file=.env --import tsx/esm scripts/seed-firmware-mock.ts'
 *
 * Refuses to run when NODE_ENV=production.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "../src/db.js";
import { FIRMWARE_INCOMING_DIR, FIRMWARE_DIR } from "../src/utils/paths.js";
import { registerUploadedImage, upsertBinding, purgeModelImages } from "../src/services/firmwareRepositoryService.js";

const CRED_NAME = "Mock device login";
const MFR = "Fortinet";

const ASSETS = [
  { hostname: "MOCK-S108FF-1",  assetType: "switch",       model: "FortiSwitch S108FF", serialNumber: "S108FFTF23000001", ipAddress: "127.0.0.2", osVersion: "7.4.3 build0542", os: "FortiSwitchOS" },
  { hostname: "MOCK-S548DF-1",  assetType: "switch",       model: "FortiSwitch S548DF", serialNumber: "S548DFTF19000001", ipAddress: "127.0.0.3", osVersion: "7.4.3 build0542", os: "FortiSwitchOS" },
  { hostname: "MOCK-FAP231K-1", assetType: "access_point", model: "FortiAP 231K",       serialNumber: "FP231KTF24000001", ipAddress: "127.0.0.4", osVersion: "FP231K-v7.4.3-build0542", os: "FortiAP" },
];

// (node, header token, filename, filler byte) — uploaded in order, so the
// LAST one per node is the primary and the one before it the backup.
const IMAGES: Array<{ assetType: "switch" | "access_point"; model: string; token: string; filename: string; filler: number }> = [
  { assetType: "switch", model: "FortiSwitch S108FF", token: "S108FF-7.06-FW-build1105-260519-patch05", filename: "FSW_108F_FPOE-v7-build1105-FORTINET.out", filler: 0x11 },
  { assetType: "switch", model: "FortiSwitch S108FF", token: "S108FF-7.06-FW-build1164-260709-patch08", filename: "FSW_108F_FPOE-v7-build1164-FORTINET.out", filler: 0x12 },
  { assetType: "switch", model: "FortiSwitch S548DF", token: "S548DF-7.06-FW-build1164-260709-patch08", filename: "FSW_548D_FPOE-v7-build1164-FORTINET.out", filler: 0x13 },
  { assetType: "access_point", model: "FortiAP 231K", token: "FP231K-7.06-AP-build1105-260519-patch05", filename: "FAP_231K-v7-build1105-FORTINET.out", filler: 0x14 },
  { assetType: "access_point", model: "FortiAP 231K", token: "FP231K-7.06-AP-build1164-260709-patch08", filename: "FAP_231K-v7-build1164-FORTINET.out", filler: 0x15 },
  // An orphaned node: a model no asset carries.
  { assetType: "switch", model: "FortiSwitch S224EN", token: "S224EN-7.02-FW-build0400-250101", filename: "FSW_224E-v7-build0400-FORTINET.out", filler: 0x16 },
];

function fakeImage(token: string, filler: number): Buffer {
  const buf = Buffer.alloc(64 * 1024, filler);
  buf.write("\u0000\u0000\u0000\u0000", 0, "latin1");
  buf.write(token, 32, "latin1");
  return buf;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed mock data: NODE_ENV=production.");
    process.exit(1);
  }
  console.log(`Seeding firmware mock (FIRMWARE_DIR=${FIRMWARE_DIR})…`);

  // ── prior rows ────────────────────────────────────────────────────────────
  await prisma.asset.deleteMany({ where: { hostname: { in: ASSETS.map((a) => a.hostname) } } });
  for (const node of new Set(IMAGES.map((i) => `${i.assetType}\u0000${i.model}`))) {
    const [assetType, model] = node.split("\u0000") as [string, string];
    await purgeModelImages({ manufacturer: MFR, assetType, model }, "seed-firmware-mock").catch(() => undefined);
  }
  await prisma.firmwareCredentialBinding.deleteMany({ where: { manufacturer: MFR, assetType: null, model: null } });
  await prisma.credential.deleteMany({ where: { name: CRED_NAME } });

  // ── assets ────────────────────────────────────────────────────────────────
  for (const a of ASSETS) {
    await prisma.asset.create({
      data: { ...a, manufacturer: MFR, status: "active", monitored: true, notes: "Mock device for the firmware repository demo — served by scripts/mock-firmware-devices.mjs" },
    });
    console.log(`  asset ${a.hostname} (${a.assetType}, ${a.serialNumber}) @ ${a.ipAddress}`);
  }

  // ── device login + binding ────────────────────────────────────────────────
  const cred = await prisma.credential.create({
    data: { name: CRED_NAME, type: "http", config: { authMode: "form", username: "admin", password: "admin" }, createdBy: "seed-firmware-mock" },
  });
  await upsertBinding({ manufacturer: MFR, credentialId: cred.id, actor: "seed-firmware-mock" });
  console.log(`  credential "${CRED_NAME}" bound at ${MFR}`);

  // ── images ────────────────────────────────────────────────────────────────
  await mkdir(FIRMWARE_INCOMING_DIR, { recursive: true });
  for (const img of IMAGES) {
    const tmpPath = join(FIRMWARE_INCOMING_DIR, `seed-${Date.now()}-${img.filler}`);
    const bytes = fakeImage(img.token, img.filler);
    await writeFile(tmpPath, bytes);
    try {
      const r = await registerUploadedImage({ tmpPath, originalName: img.filename, sizeBytes: bytes.length, manufacturer: MFR, assetType: img.assetType, model: img.model, actor: "seed-firmware-mock" });
      console.log(`  image ${img.model}: ${r.image.versionLabel} (${r.image.platform}) → ${r.image.role}` + (r.demoted ? `; ${r.demoted.versionLabel} now backup` : "") + (r.warnings.length ? ` — ${r.warnings.join(" ")}` : ""));
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }
  console.log("Done. Start the mock devices: node scripts/mock-firmware-devices.mjs");
}

main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
