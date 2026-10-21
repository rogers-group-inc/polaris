// @vitest-environment happy-dom
/**
 * tests/unit/pinnedTlsCertsDom.test.ts — the Pinned server identities
 * surface (business rule 113(f)). Server Settings → Web Server and the
 * Windows SSH Deployment card mount a one-line summary and a "View pinned
 * identities" button; the button opens one slide-over listing every TLS
 * certificate AND SSH host key pin with its asset(s) as links that open the
 * asset panel in place (`/assets.html#view=asset:<id>`, which app.js's
 * delegate intercepts), the integration(s) that dial it, both fingerprints for
 * a changed certificate, Trust / Delete for an administrator, and one filter
 * bar (search + kind) over both kinds.
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

const HOST_KEYS = [
  {
    id: "k1", host: "10.0.0.5", port: 22, keyType: "ssh-ed25519", fingerprint: "SHA256:Zm9vYmFyYmF6cXV4",
    firstSeen: "2026-10-02T00:00:00Z", lastSeen: "2026-10-14T00:00:00Z",
    assets: [{ id: "asset-db01", hostname: "db01", ipAddress: "10.0.0.5" }],
  },
];

let ARCHIVED: unknown[] = [];

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
      sshHostKeysList: vi.fn(async () => ({ hostKeys: HOST_KEYS })),
      sshHostKeyDelete: vi.fn(async () => ({})),
      archivedHostPinsList: vi.fn(async () => ({ archivedPins: ARCHIVED })),
    },
  };
  new Function(SRC)();
  g.PolarisPinnedTlsCerts.mount(document.getElementById("host"));
  return g;
}

beforeEach(() => { document.body.innerHTML = ""; ARCHIVED = []; });

describe("pinned server identities summary + slide-over", () => {
  it("mounts a summary counting both kinds, the changed count and a button, not a table", async () => {
    boot(true);
    await flush();
    const host = document.getElementById("host")!;
    expect(host.textContent).toContain("Pinned: 2 certificates · 1 SSH host key.");
    expect(host.querySelector(".badge-conflict")!.textContent).toBe("1 changed");
    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector("[data-tls-pins-open]")!.textContent).toBe("View pinned identities");
  });

  it("a failed SSH list still shows the certificates and names the failure", async () => {
    const g = boot(true);
    g.api.serverSettings.sshHostKeysList = vi.fn(async () => { throw new Error("boom"); });
    g.PolarisPinnedTlsCerts.mount(document.getElementById("host"));
    await flush(); await flush();
    const host = document.getElementById("host")!;
    expect(host.textContent).toContain("2 certificates · 0 SSH host keys");
    expect(host.textContent).toContain("Could not load pinned SSH host keys: boom");
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
    expect(overlay.querySelectorAll(".pin-card")).toHaveLength(3);
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
    expect(document.getElementById("tls-pins-meta")!.textContent).toContain("3 pinned · 1 changed");
  });

  it("lists a host's SSH key beside its certificate, after the changed one", async () => {
    boot(true);
    await flush();
    (document.querySelector("[data-tls-pins-open]") as HTMLButtonElement).click();
    await flush();
    const order = Array.from(document.querySelectorAll(".pin-card")).map((c) => c.className.split(" ")[1] + " " + c.querySelector(".mono")!.textContent);
    expect(order).toEqual(["tls-pin-card 172.22.128.104:443", "tls-pin-card 10.0.0.5:443", "ssh-pin-card 10.0.0.5:22"]);
    const ssh = document.querySelector(".ssh-pin-card")!;
    expect(ssh.textContent).toContain("ssh-ed25519");
    expect(ssh.textContent).toContain("SHA256:Zm9vYmFyYmF6cXV4");
    expect(ssh.querySelector("a")!.getAttribute("href")).toBe("/assets.html#view=asset:asset-db01");
  });

  it("Delete on an SSH card deletes the host key pin and reloads", async () => {
    const g = boot(true);
    await flush();
    (document.querySelector("[data-tls-pins-open]") as HTMLButtonElement).click();
    await flush();
    (document.querySelector("[data-ssh-del]") as HTMLButtonElement).click();
    await flush(); await flush();
    expect(g.api.serverSettings.sshHostKeyDelete).toHaveBeenCalledWith("k1");
    expect(g.api.serverSettings.tlsCertPinDelete).not.toHaveBeenCalled();
    expect(g.api.serverSettings.sshHostKeysList.mock.calls.length).toBeGreaterThanOrEqual(4);
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
    expect(document.querySelector("[data-ssh-del]")).toBeNull();
  });

  it("one filter bar narrows both kinds by address, hostname, thumbprint, subject, key type and kind", async () => {
    boot(true);
    await flush();
    (document.querySelector("[data-tls-pins-open]") as HTMLButtonElement).click();
    await flush();
    expect(document.querySelectorAll("#tls-pins-filters input")).toHaveLength(1);
    const q = document.querySelector('#tls-pins-filters [data-pin-filter="q"]') as HTMLInputElement;
    const kind = document.querySelector('#tls-pins-filters [data-pin-filter="kind"]') as HTMLSelectElement;
    const set = (v: string) => { q.value = v; q.dispatchEvent(new Event("input", { bubbles: true })); };
    const pick = (v: string) => { kind.value = v; kind.dispatchEvent(new Event("change", { bubbles: true })); };
    const hosts = () => Array.from(document.querySelectorAll(".pin-card > div:first-child .mono")).map((e) => e.textContent);

    set("10.0.0");
    expect(hosts()).toEqual(["10.0.0.5:443", "10.0.0.5:22"]);
    expect(document.getElementById("tls-pins-meta")!.textContent).toContain("2 of 3 pinned");

    // Hostname reaches through the asset join on both kinds.
    set("spk2");
    expect(hosts()).toEqual(["172.22.128.104:443"]);
    set("DB01");
    expect(hosts()).toEqual(["10.0.0.5:22"]);

    // A pasted thumbprint: colons, spaces and case ignored; the now-presented one counts.
    set("cd:cd:CD");
    expect(hosts()).toEqual(["172.22.128.104:443"]);
    set("ef ef ef");
    expect(hosts()).toEqual(["10.0.0.5:443"]);
    // An SSH fingerprint as ssh-keygen prints it.
    set("SHA256:Zm9v");
    expect(hosts()).toEqual(["10.0.0.5:22"]);

    // Words AND together: subject + address, key type + address.
    set("fmg 10.0");
    expect(hosts()).toEqual(["10.0.0.5:443"]);
    set("ed25519 172.22");
    expect(document.querySelectorAll(".pin-card")).toHaveLength(0);
    expect(document.getElementById("tls-pins-body")!.textContent).toContain("No pinned identity matches");

    set("");
    pick("ssh");
    expect(hosts()).toEqual(["10.0.0.5:22"]);
    pick("tls");
    set("10.0.0.5");
    expect(hosts()).toEqual(["10.0.0.5:443"]);
    pick("");
    set("");
    expect(document.querySelectorAll(".pin-card")).toHaveLength(3);
    expect(document.getElementById("tls-pins-meta")!.textContent).toContain("3 pinned · 1 changed");
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

  it("lists archived pins last, read-only, and the Archived kind shows only them", async () => {
    ARCHIVED = [{
      kind: "ssh", host: "10.9.9.9", port: 22, fingerprint: "SHA256:b2xkTWFjaGluZUtleQ", keyType: "ssh-ed25519",
      firstSeen: "2026-09-01T00:00:00Z", lastSeen: "2026-10-01T00:00:00Z", archivedAt: "2026-10-10T00:00:00Z",
      asset: { id: "asset-old", hostname: "oldbox", ipAddress: "10.9.9.9", status: "decommissioned" },
    }];
    boot(true);
    await flush();
    expect(document.getElementById("host")!.textContent).toContain("· 1 archived.");
    (document.querySelector("[data-tls-pins-open]") as HTMLButtonElement).click();
    await flush();
    const cards = Array.from(document.querySelectorAll(".pin-card"));
    expect(cards).toHaveLength(4);
    const last = cards[cards.length - 1];
    expect(last.classList.contains("archived-pin-card")).toBe(true);
    expect(last.textContent).toContain("Archived");
    expect(last.querySelector("a")!.getAttribute("href")).toBe("/assets.html#view=asset:asset-old");
    expect(last.querySelector("button")).toBeNull();
    expect(document.getElementById("tls-pins-meta")!.textContent).toContain("4 pinned · 1 changed · 1 archived");

    const q = document.querySelector('#tls-pins-filters [data-pin-filter="q"]') as HTMLInputElement;
    q.value = "oldbox"; q.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelectorAll(".pin-card")).toHaveLength(1);
    q.value = ""; q.dispatchEvent(new Event("input", { bubbles: true }));
    const kind = document.querySelector('#tls-pins-filters [data-pin-filter="kind"]') as HTMLSelectElement;
    kind.value = "archived"; kind.dispatchEvent(new Event("change", { bubbles: true }));
    expect(Array.from(document.querySelectorAll(".pin-card")).map((c) => c.classList.contains("archived-pin-card"))).toEqual([true]);
    // SSH includes the archived host key alongside the live one.
    kind.value = "ssh"; kind.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelectorAll(".pin-card")).toHaveLength(2);
  });
});
