// @vitest-environment happy-dom
/**
 * tests/unit/pinnedTlsCertsDom.test.ts — the Pinned server identities
 * surface (business rule 113(f)). Server Settings → Web Server and the
 * Windows SSH Deployment card mount a one-line summary and a "View pinned
 * certificates" button; the button opens a slide-over listing every pin with
 * its asset(s) as links that open the asset panel in place
 * (`/assets.html#view=asset:<id>`, which app.js's delegate intercepts), the
 * integration(s) that dial it, both fingerprints for a changed certificate and
 * Trust / Delete for an administrator.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "pinned-tls-certs.js"), "utf-8");

const PINS = [
  {
    id: "p1", host: "172.22.128.104", port: 443, fingerprint: "AB".repeat(32), subject: "FortiGate",
    firstSeen: "2026-10-14T18:29:09Z", lastSeen: "2026-10-14T18:31:06Z",
    pendingFingerprint: "CD".repeat(32), pendingSubject: "FortiGate", pendingSeenAt: "2026-10-14T18:40:00Z", repinUntil: null,
    assets: [{ id: "asset-spk2", hostname: "SPK2", ipAddress: "172.22.128.104" }],
    integrations: [{ id: "i1", name: "lab-spoke2", type: "fortigate" }],
  },
  {
    id: "p2", host: "10.0.0.5", port: 443, fingerprint: "EF".repeat(32), subject: "FMG",
    firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-14T00:00:00Z",
    pendingFingerprint: null, pendingSubject: null, pendingSeenAt: null, repinUntil: null,
    assets: [], integrations: [{ id: "i2", name: "Corp FMG", type: "fortimanager" }],
  },
];

const flush = () => new Promise((r) => setTimeout(r, 0));

function boot(canManage: boolean) {
  document.body.innerHTML = '<div id="host"></div>';
  const g = globalThis as any;
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  g.permAtLeast = () => canManage;
  g.showToast = vi.fn();
  g.showConfirm = vi.fn(async () => true);
  g.raiseSlideover = vi.fn();
  g.wireSlideoverEscape = vi.fn();
  g.initSlideoverResize = vi.fn();
  g.api = {
    serverSettings: {
      tlsCertPinsList: vi.fn(async () => ({ certPins: PINS })),
      tlsCertPinTrust: vi.fn(async () => ({})),
      tlsCertPinDelete: vi.fn(async () => ({})),
    },
  };
  new Function(SRC)();
  g.PolarisPinnedTlsCerts.mount(document.getElementById("host"));
  return g;
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("pinned certificates summary + slide-over", () => {
  it("mounts a summary with the changed count and a button, not a table", async () => {
    boot(true);
    await flush();
    const host = document.getElementById("host")!;
    expect(host.textContent).toContain("2 pinned certificates.");
    expect(host.querySelector(".badge-conflict")!.textContent).toBe("1 changed");
    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector("[data-tls-pins-open]")!.textContent).toBe("View pinned certificates");
  });

  it("opens a slide-over listing each pin with asset links, integrations and both fingerprints", async () => {
    const g = boot(true);
    await flush();
    (document.querySelector("[data-tls-pins-open]") as HTMLButtonElement).click();
    await flush();
    const overlay = document.getElementById("tls-pins-overlay")!;
    expect(overlay.classList.contains("open")).toBe(true);
    expect(g.raiseSlideover).toHaveBeenCalledWith(overlay);
    expect(g.wireSlideoverEscape).toHaveBeenCalled();
    const cards = overlay.querySelectorAll(".tls-pin-card");
    expect(cards).toHaveLength(2);

    const link = cards[0].querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/assets.html#view=asset:asset-spk2");
    expect(link.textContent).toBe("SPK2");
    expect(cards[0].textContent).toContain("lab-spoke2");
    expect(cards[0].textContent).toContain("Certificate changed");
    expect(cards[0].textContent).toContain("Now presents");
    expect(cards[0].textContent).toContain("CD:CD:CD");

    // A FortiManager with no asset of its own still names its integration.
    expect(cards[1].querySelector("a")).toBeNull();
    expect(cards[1].textContent).toContain("No asset at this address");
    expect(cards[1].textContent).toContain("Corp FMG");
    expect(document.getElementById("tls-pins-meta")!.textContent).toContain("2 pinned · 1 changed");
  });

  it("Trust sends the exact pending fingerprint, then reloads the panel and the summary", async () => {
    const g = boot(true);
    await flush();
    (document.querySelector("[data-tls-pins-open]") as HTMLButtonElement).click();
    await flush();
    (document.querySelector("[data-pin-trust]") as HTMLButtonElement).click();
    await flush(); await flush();
    expect(g.api.serverSettings.tlsCertPinTrust).toHaveBeenCalledWith("p1", "CD".repeat(32));
    // initial summary + panel open + reload of both after the trust
    expect(g.api.serverSettings.tlsCertPinsList.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("a read-only viewer sees no Trust or Delete", async () => {
    boot(false);
    await flush();
    (document.querySelector("[data-tls-pins-open]") as HTMLButtonElement).click();
    await flush();
    expect(document.querySelector("[data-pin-trust]")).toBeNull();
    expect(document.querySelector("[data-pin-del]")).toBeNull();
  });

  it("closes from the X, the footer button and a backdrop click", async () => {
    boot(true);
    await flush();
    const open = () => (document.querySelector("[data-tls-pins-open]") as HTMLButtonElement).click();
    const overlay = () => document.getElementById("tls-pins-overlay")!;
    open(); await flush();
    (document.getElementById("tls-pins-close") as HTMLButtonElement).click();
    expect(overlay().classList.contains("open")).toBe(false);
    open(); await flush();
    (document.getElementById("tls-pins-done") as HTMLButtonElement).click();
    expect(overlay().classList.contains("open")).toBe(false);
    open(); await flush();
    overlay().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(overlay().classList.contains("open")).toBe(false);
  });
});
