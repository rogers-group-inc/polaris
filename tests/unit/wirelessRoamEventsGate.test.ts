/**
 * tests/unit/wirelessRoamEventsGate.test.ts — a wireless client's roam to
 * another AP is written as an Event only while an automation uses the
 * "Wireless AP changed (roam)" trigger (operator decision 2026-11-09: every
 * client's every roam, unconditionally, dominated the Events log).
 *
 * The gate is the same subscription the `change.*` events use; its three
 * callers (the wireless scrape in monitoringService, the upstream-chain sweep,
 * discovery's change-event flush) are pinned by source below so a fourth
 * writer cannot slip past it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const { subscribed } = vi.hoisted(() => ({ subscribed: vi.fn() }));
vi.mock("../../src/services/notificationRuleService.js", () => ({ isChangeActionSubscribed: subscribed }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEventsBatch: vi.fn() }));

const { wirelessRoamEventsWanted } = await import("../../src/services/notificationChangeEvents.js");

describe("wirelessRoamEventsWanted", () => {
  // Block body: an arrow returning the mock would be run by Vitest as teardown.
  beforeEach(() => { subscribed.mockReset(); });

  it("asks about the roam trigger's own action", async () => {
    subscribed.mockResolvedValue(true);
    expect(await wirelessRoamEventsWanted()).toBe(true);
    expect(subscribed).toHaveBeenCalledWith("asset.wireless_ap.changed");
  });

  it("writes nothing when no automation uses it — the normal case", async () => {
    subscribed.mockResolvedValue(false);
    expect(await wirelessRoamEventsWanted()).toBe(false);
  });

  it("a failed lookup answers no: an audit row never fails the write it rides on", async () => {
    subscribed.mockRejectedValue(new Error("db down"));
    expect(await wirelessRoamEventsWanted()).toBe(false);
  });
});

describe("every roam-Event writer asks the gate", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
  // discovery's Phase 11.5 flush lives in discovery/dhcp/changeEvents.ts (CQ-B060);
  // the wireless scrape's writer in monitoring/neighborPersistence.ts (CQ-B061).
  const writers = ["src/services/monitoring/neighborPersistence.ts", "src/services/ipUpstreamChainService.ts", "src/services/discovery/dhcp/changeEvents.ts"];

  it("each file that builds an \"ap\" connection event also calls wirelessRoamEventsWanted", () => {
    for (const f of writers) {
      const src = read(f);
      expect(src, f).toMatch(/buildConnectionChangedEvent\(\s*"ap"/);
      expect(src, f).toMatch(/wirelessRoamEventsWanted\(\)/);
    }
  });

  it("no other source file builds one", () => {
    const root = resolve(__dirname, "../..");
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "generated") walk(p); continue; }
        if (e.name.endsWith(".ts") && /buildConnectionChangedEvent\(\s*"ap"/.test(readFileSync(p, "utf8"))) {
          found.push(relative(root, p).replace(/\\/g, "/"));
        }
      }
    };
    walk(join(root, "src"));
    expect(found.sort()).toEqual([...writers].sort());
  });
});
