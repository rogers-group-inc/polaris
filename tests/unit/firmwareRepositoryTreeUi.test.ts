/**
 * tests/unit/firmwareRepositoryTreeUi.test.ts — Server Settings → Repository
 * (business rule 87): the tree, its pills, its gates, and the credential form's
 * new device-login mode.
 *
 * What is pinned is what would quietly mislead an operator standing at a
 * model node: a login pill that says "set here" when it is inherited (or the
 * reverse), a backup image drawn as the primary, an orphaned model folded
 * away behind a caret, an upload or delete verb shown to a role that may only
 * look, and a credential picker offering a Basic credential as a device login.
 *
 * Both scripts are plain browser files whose only load-time side effect is a
 * DOMContentLoaded listener or a `window.PolarisFirmwareTab` assignment, so
 * they eval into a happy-dom Window (the manufacturerProfileScopeUi harness).
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { fixSelects } from "../fixtures/happyDomSelects.js";

type Tab = {
  cardHTML: () => string;
  runsCardHTML: () => string;
  bindingPillHTML: (node: unknown, ctx: unknown) => string;
  credentialOptionsHTML: (list: unknown[], currentId: string | null) => string;
  bindingEditorHTML: (node: unknown, ctx: unknown) => string;
  isOpen: (key: string, depth: number, orphaned: boolean) => boolean;
  nodeKey: (...parts: string[]) => string;
  _setState: (s: Record<string, unknown>) => void;
};

interface Sandbox {
  PolarisFirmwareTab: Tab;
  _settingsTabVisible: (key: string) => boolean;
  credHttpForm: (cfg: Record<string, unknown>) => string;
  httpAuthModeOf: (cfg: Record<string, unknown>) => string;
  credSummary: (c: Record<string, unknown>) => string;
  readCredentialForm: (type: string) => Record<string, unknown>;
  wireHttpAuthModeToggle: () => void;
  document: Document;
  __perm: (key: string, level: string) => boolean;
  __isAdmin: () => boolean;
}

let sb: Sandbox;
let level = "fullwrite";
let admin = true;
const RANK: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };

beforeAll(() => {
  const win = new Window({ url: "https://polaris.test/server-settings.html" });
  Object.assign(win as unknown as Record<string, unknown>, {
    formatBytes: (n: number) => n + " B",
    timeAgo: () => "2 days ago",
    escapeHtml: (x: unknown) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)),
    showToast: () => {},
    calloutHTML: (_v: string, title: string, body: string) => `<div class="callout"><b>${title}</b> ${body}</div>`,
    permAtLeast: (key: string, want: string) => key === "firmware" && RANK[level] >= RANK[want],
    isAdmin: () => admin,
    api: {},
  });
  for (const file of ["../../public/js/server-settings.js", "../../public/js/server-settings-firmware.js"]) {
    (win as unknown as { eval: (s: string) => void }).eval(readFileSync(resolve(__dirname, file), "utf8"));
  }
  sb = win as unknown as Sandbox;
});

beforeEach(() => {
  level = "fullwrite";
  admin = true;
  sb.PolarisFirmwareTab._setState({ tree: fixture(), runs: [], credentials: [], expanded: {}, bindingEdit: {} });
});

function image(over: Record<string, unknown> = {}) {
  return {
    id: "img-1", manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", platform: "S108FF",
    versionLabel: "7.6.8 build1164", role: "primary", filename: "FSW_108F-v7-build1164-FORTINET.out", sizeBytes: 45678901,
    sha256: "abc", uploadedBy: "dmoore", uploadedAt: "2026-09-20T14:02:00Z", fileMissing: false, warnings: [] as string[], ...over,
  };
}
const eff = (name: string, scope: string) => ({ credentialId: "c-" + scope, credentialName: name, scope });
const own = (name: string, scope: string) => ({ id: "b-" + scope, credentialId: "c-" + scope, credentialName: name, stale: false });

function fixture() {
  return {
    manufacturers: [
      {
        name: "Fortinet", assetCount: 15, binding: own("FSW admin", "manufacturer"), effectiveBinding: eff("FSW admin", "manufacturer"),
        assetTypes: [
          {
            assetType: "switch", label: "Switch", engine: "fortiswitch-https", assetCount: 12, binding: null, effectiveBinding: eff("FSW admin", "manufacturer"),
            models: [
              { model: "FortiSwitch S108FF", assetCount: 10, orphaned: false, binding: null, effectiveBinding: eff("FSW admin", "manufacturer"),
                images: [image(), image({ id: "img-2", role: "backup", versionLabel: "7.4.3 build0542", warnings: ["No asset under this model carries serial prefix S108FF."] })] },
              { model: "FortiSwitch S548DF", assetCount: 2, orphaned: false, binding: own("Core login", "model"), effectiveBinding: eff("Core login", "model"), images: [] },
              { model: "FortiSwitch S224E", assetCount: 0, orphaned: true, binding: null, effectiveBinding: eff("FSW admin", "manufacturer"),
                images: [image({ id: "img-9", model: "FortiSwitch S224E", platform: "S224EN", versionLabel: "7.2.5 build0400" })] },
            ],
          },
          {
            assetType: "access_point", label: "Access Point", engine: "fortiap-https", assetCount: 3, binding: own("AP login", "assetType"), effectiveBinding: eff("AP login", "assetType"),
            models: [{ model: "FortiAP 231F", assetCount: 3, orphaned: false, binding: null, effectiveBinding: eff("AP login", "assetType"), images: [] }],
          },
        ],
      },
      {
        name: "Aruba", assetCount: 4, binding: null, effectiveBinding: null,
        assetTypes: [{ assetType: "switch", label: "Switch", engine: null, assetCount: 4, binding: null, effectiveBinding: null,
          models: [{ model: "6300M", assetCount: 4, orphaned: false, binding: null, effectiveBinding: null, images: [] }] }],
      },
    ],
  };
}

function renderCard(): HTMLElement {
  const host = sb.document.createElement("div");
  host.innerHTML = sb.PolarisFirmwareTab.cardHTML();
  return host as unknown as HTMLElement;
}
const node = (root: HTMLElement, mfr: string, type?: string, model?: string) =>
  root.querySelector(`.fw-node[data-fw-key="${sb.PolarisFirmwareTab.nodeKey(...([mfr, type, model].filter(Boolean) as string[]))}"]`)!;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("the tree", () => {
  it("draws manufacturer › device type › model with the registry's labels and summed counts", () => {
    const root = renderCard();
    expect(text(node(root, "Fortinet").querySelector(".fw-node-header .fw-node-title"))).toBe("Fortinet");
    expect(text(node(root, "Fortinet").querySelector(".fw-node-header .fw-node-meta"))).toBe("15 assets");
    const sw = node(root, "Fortinet", "switch");
    expect(text(sw.querySelector(".fw-node-header .fw-node-title"))).toBe("Switch");
    expect(text(sw.querySelector(".fw-node-header .fw-node-meta"))).toBe("3 models · 12 assets");
    expect(text(node(root, "Fortinet", "access_point").querySelector(".fw-node-header .fw-node-title"))).toBe("Access Point");
    const m = node(root, "Fortinet", "switch", "FortiSwitch S108FF");
    expect(text(m.querySelector(".fw-node-header .fw-node-meta"))).toBe("10 assets · 2 images");
  });

  it("opens manufacturer and type nodes by default and keeps a model closed until expanded", () => {
    const root = renderCard();
    expect(node(root, "Fortinet").querySelector(".fw-node-body")!.getAttribute("style")).toBeNull();
    expect(node(root, "Fortinet", "switch", "FortiSwitch S108FF").querySelector(".fw-node-body")!.getAttribute("style")).toMatch(/display:none/);
    sb.PolarisFirmwareTab._setState({ expanded: { [sb.PolarisFirmwareTab.nodeKey("Fortinet", "switch", "FortiSwitch S108FF")]: true } });
    const open = renderCard();
    expect(node(open, "Fortinet", "switch", "FortiSwitch S108FF").querySelector(".fw-node-body")!.getAttribute("style")).toBeNull();
  });

  it("keeps a model's rows in version order when the backup is the newer image, so a swap moves the pills, not the versions", () => {
    // The server hands rows primary-first; after Make primary on an older
    // image that order would only trade the version strings between rows.
    sb.PolarisFirmwareTab._setState({ expanded: { [sb.PolarisFirmwareTab.nodeKey("Fortinet", "switch", "FortiSwitch S108FF")]: true } });
    const swapped = fixture();
    const mdl = swapped.manufacturers[0]!.assetTypes[0]!.models[0]! as { images: Array<Record<string, unknown>> };
    mdl.images = [
      image({ id: "img-old", role: "primary", versionLabel: "7.4.3 build0542", version: { major: 7, minor: 4, patch: 3, build: 542 } }),
      image({ id: "img-new", role: "backup", versionLabel: "7.6.8 build1164", version: { major: 7, minor: 6, patch: 8, build: 1164 } }),
    ];
    sb.PolarisFirmwareTab._setState({ tree: swapped });
    const rows = Array.from(node(renderCard(), "Fortinet", "switch", "FortiSwitch S108FF").querySelectorAll(".fw-images tbody tr"));
    expect(rows.map((r) => r.getAttribute("data-image-id"))).toEqual(["img-new", "img-old"]);
    expect(text(rows[0]!.querySelector(".fw-role-pill"))).toBe("Backup");
    expect(text(rows[1]!.querySelector(".fw-role-pill"))).toBe("Primary");
    expect(rows[0]!.querySelector(".fw-image-promote")).not.toBeNull();
    expect(rows[1]!.querySelector(".fw-image-promote")).toBeNull();
  });

  it("lists a model's images newest first with role pills, the warning pill, and Make primary only on the backup", () => {
    sb.PolarisFirmwareTab._setState({ expanded: { [sb.PolarisFirmwareTab.nodeKey("Fortinet", "switch", "FortiSwitch S108FF")]: true } });
    const rows = Array.from(node(renderCard(), "Fortinet", "switch", "FortiSwitch S108FF").querySelectorAll(".fw-images tbody tr"));
    expect(rows).toHaveLength(2);
    expect(text(rows[0]!.querySelector(".fw-role-pill"))).toBe("Primary");
    expect(text(rows[1]!.querySelector(".fw-role-pill"))).toBe("Backup");
    expect(text(rows[0]!)).toContain("7.6.8 build1164");
    expect(text(rows[0]!)).toContain("S108FF");
    expect(text(rows[0]!)).toContain("45678901 B");
    expect(text(rows[0]!)).toContain("dmoore · 2 days ago");
    expect(rows[0]!.querySelector(".fw-warn-pill")).toBeNull();
    expect(rows[1]!.querySelector(".fw-warn-pill")!.getAttribute("title")).toMatch(/serial prefix S108FF/);
    expect(rows[0]!.querySelector(".fw-image-promote")).toBeNull();
    expect(rows[1]!.querySelector(".fw-image-promote")).not.toBeNull();
    expect(rows[0]!.querySelector(".fw-image-del")).not.toBeNull();
    expect(text(node(renderCard(), "Fortinet", "switch", "FortiSwitch S108FF"))).toMatch(/A model keeps two images/);
  });

  it("says when a model has no images, and when a type has no upgrade engine", () => {
    sb.PolarisFirmwareTab._setState({ expanded: { [sb.PolarisFirmwareTab.nodeKey("Fortinet", "switch", "FortiSwitch S548DF")]: true } });
    const root = renderCard();
    expect(text(node(root, "Fortinet", "switch", "FortiSwitch S548DF").querySelector(".empty-state"))).toBe("No images uploaded for this model.");
    expect(text(node(root, "Aruba", "switch").querySelector(".fw-engine-pill"))).toBe("No upgrade engine");
    expect(node(root, "Fortinet", "switch").querySelector(".fw-engine-pill")).toBeNull();
  });

  it("flags an orphaned model: amber class, warning pill, open by default, the purge verb — and only there", () => {
    const root = renderCard();
    const orphan = node(root, "Fortinet", "switch", "FortiSwitch S224E");
    expect(orphan.classList.contains("is-orphaned")).toBe(true);
    expect(text(orphan.querySelector(".fw-orphan-pill"))).toBe("No assets carry this model any more");
    expect(orphan.querySelector(".fw-node-body")!.getAttribute("style")).toBeNull();
    expect(orphan.querySelector(".fw-model-purge")).not.toBeNull();
    expect(text(orphan.querySelector(".fw-model-purge"))).toBe("Delete firmware for this model");
    expect(node(root, "Fortinet", "switch", "FortiSwitch S108FF").querySelector(".fw-model-purge")).toBeNull();
    expect(root.querySelectorAll(".fw-model-purge")).toHaveLength(1);
  });

  it("renders the empty tree honestly", () => {
    sb.PolarisFirmwareTab._setState({ tree: { manufacturers: [] } });
    expect(text(renderCard().querySelector(".empty-state"))).toMatch(/No switches or access points in the inventory yet/);
  });
});

describe("the login pills — the server's scope, never a client guess", () => {
  const ctx = { mfrName: "Fortinet", typeLabel: "Switch" };
  const pill = (n: unknown) => {
    const host = sb.document.createElement("div");
    host.innerHTML = sb.PolarisFirmwareTab.bindingPillHTML(n, ctx);
    return host.querySelector(".fw-binding-pill")!;
  };
  it("set here", () => {
    const p = pill({ binding: own("Core login", "model"), effectiveBinding: eff("Core login", "model") });
    expect(p.classList.contains("is-own")).toBe(true);
    expect(text(p)).toBe("Login: Core login");
  });
  it("inherited from the device type", () => {
    const p = pill({ binding: null, effectiveBinding: eff("AP login", "assetType") });
    expect(p.classList.contains("is-inherited")).toBe(true);
    expect(text(p)).toBe("Login: AP login · inherited from Fortinet › Switch");
  });
  it("inherited from the manufacturer", () => {
    expect(text(pill({ binding: null, effectiveBinding: eff("FSW admin", "manufacturer") }))).toBe("Login: FSW admin · inherited from Fortinet");
  });
  it("none — and a stale binding says so in its title", () => {
    const p = pill({ binding: null, effectiveBinding: null });
    expect(p.classList.contains("is-none")).toBe(true);
    expect(text(p)).toBe("No device login");
    expect(pill({ binding: { id: "b", credentialId: null, credentialName: null, stale: true }, effectiveBinding: null }).getAttribute("title")).toMatch(/was deleted/);
  });
});

describe("the manufacturer's login pill names the device types no login reaches", () => {
  const mctx = { mfrName: "Fortinet", typeLabel: "" };
  const mpill = (m: unknown) => {
    const host = sb.document.createElement("div");
    host.innerHTML = sb.PolarisFirmwareTab.manufacturerLoginPillHTML(m, mctx);
    return host.querySelector(".fw-binding-pill");
  };
  const mdl = (name: string, effective: unknown) => ({ model: name, assetCount: 1, orphaned: false, binding: null, effectiveBinding: effective, images: [] });
  const type = (assetType: string, label: string, effective: unknown, models: unknown[]) => ({ assetType, label, engine: null, assetCount: 1, binding: null, effectiveBinding: effective, models });

  it("a login bound on the manufacturer reads like any other node", () => {
    const p = mpill({ name: "Fortinet", binding: own("FSW admin", "manufacturer"), effectiveBinding: eff("FSW admin", "manufacturer"), assetTypes: [] })!;
    expect(text(p)).toBe("Login: FSW admin");
  });

  it("no pill at all when every device type is covered — by the type, or by each of its models", () => {
    // The operator's screenshot: Switch bound at the type, and here Access
    // Point covered model by model. Nothing is missing, so nothing warns.
    const m = {
      name: "Fortinet", binding: null, effectiveBinding: null,
      assetTypes: [
        type("switch", "Switch", eff("FortiSwitch HTTP", "assetType"), [mdl("FortiSwitch", eff("FortiSwitch HTTP", "assetType"))]),
        type("access_point", "Access Point", null, [mdl("FortiAP 231K", eff("AP 231K", "model")), mdl("FortiAP 431F", eff("AP 431F", "model"))]),
      ],
    };
    expect(mpill(m)).toBeNull();
  });

  it("names exactly the types left uncovered, including one where only SOME models carry a login", () => {
    const m = {
      name: "Fortinet", binding: null, effectiveBinding: null,
      assetTypes: [
        type("switch", "Switch", eff("FortiSwitch HTTP", "assetType"), [mdl("FortiSwitch", eff("FortiSwitch HTTP", "assetType"))]),
        type("access_point", "Access Point", null, [mdl("FortiAP 231K", eff("AP 231K", "model")), mdl("FortiAP 431F", null)]),
      ],
    };
    const p = mpill(m)!;
    expect(p.classList.contains("is-none")).toBe(true);
    expect(text(p)).toBe("No device login for Access Point");
  });

  it("lists every uncovered type, in tree order", () => {
    const m = {
      name: "Fortinet", binding: null, effectiveBinding: null,
      assetTypes: [type("switch", "Switch", null, [mdl("a", null)]), type("access_point", "Access Point", null, [mdl("b", null)])],
    };
    expect(text(mpill(m))).toBe("No device login for Switch, Access Point");
  });

  it("a deleted manufacturer credential says so, and still names only what is uncovered", () => {
    const m = {
      name: "Fortinet", binding: { id: "b", credentialId: null, credentialName: null, stale: true }, effectiveBinding: null,
      assetTypes: [type("switch", "Switch", null, [mdl("a", null)])],
    };
    const p = mpill(m)!;
    expect(text(p)).toBe("No device login for Switch");
    expect(p.getAttribute("title")).toMatch(/was deleted/);
  });

  it("the tree renders it on the manufacturer node", () => {
    // Aruba in the fixture: nothing bound anywhere.
    expect(text(node(renderCard(), "Aruba").querySelector(".fw-node-header .fw-binding-pill"))).toBe("No device login for Switch");
  });
});

describe("the asset count", () => {
  it("is plain text without assets:read, and a button that names its scope with it", () => {
    const meta = () => node(renderCard(), "Fortinet", "switch", "FortiSwitch S108FF").querySelector(".fw-node-header .fw-node-meta")!;
    expect(meta().querySelector(".fw-asset-count")).toBeNull();
    const prev = (sb as unknown as { permAtLeast: unknown }).permAtLeast;
    (sb as unknown as { permAtLeast: unknown }).permAtLeast = (key: string, want: string) => (key === "assets" && want === "read") || (key === "firmware" && RANK[level] >= RANK[want]);
    try {
      const btn = meta().querySelector(".fw-asset-count")!;
      expect(text(btn)).toBe("10 assets");
      expect(btn.getAttribute("title")).toBe("List the devices in Fortinet › Switch › FortiSwitch S108FF");
      // A zero count never opens an empty list.
      expect(node(renderCard(), "Fortinet", "switch", "FortiSwitch S224E").querySelector(".fw-asset-count")).toBeNull();
    } finally {
      (sb as unknown as { permAtLeast: unknown }).permAtLeast = prev;
    }
  });
});

describe("the binding editor", () => {
  const creds = [
    { id: "c1", name: "FSW admin", type: "http", config: { authMode: "form", username: "admin" } },
    { id: "c2", name: "Monitor basic", type: "http", config: { authMode: "basic", username: "mon" } },
    { id: "c3", name: "Old http", type: "http", config: { username: "u", password: "p" } }, // inferred basic
    { id: "c4", name: "Switch SSH", type: "ssh", config: { username: "admin" } },
    { id: "c5", name: "AP login", type: "http", config: { authMode: "form", username: "admin" } },
  ];
  it("offers only http credentials in form mode", () => {
    const host = sb.document.createElement("select");
    host.innerHTML = sb.PolarisFirmwareTab.credentialOptionsHTML(creds, "c5");
    const opts = Array.from(host.querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(opts).toEqual(["c1", "c5"]);
    fixSelects({ querySelectorAll: () => [host] });
    expect(host.value).toBe("c5");
  });
  it("leads with 'Inherit — <effective>' when the node inherits, and 'Inherit — none' otherwise", () => {
    sb.PolarisFirmwareTab._setState({ credentials: creds });
    const host = sb.document.createElement("div");
    host.innerHTML = sb.PolarisFirmwareTab.bindingEditorHTML({ binding: null, effectiveBinding: eff("FSW admin", "manufacturer") }, { mfrName: "Fortinet", typeLabel: "Switch" });
    expect(text(host.querySelector("option"))).toBe("Inherit — FSW admin");
    host.innerHTML = sb.PolarisFirmwareTab.bindingEditorHTML({ binding: null, effectiveBinding: null }, { mfrName: "Aruba", typeLabel: "Switch" });
    expect(text(host.querySelector("option"))).toBe("Inherit — none");
    expect(host.querySelector(".fw-binding-new")).not.toBeNull();
  });
});

describe("gating on the firmware key", () => {
  it("at read: no upload, delete, make-primary, purge or Set login verbs", () => {
    level = "read";
    sb.PolarisFirmwareTab._setState({ expanded: { [sb.PolarisFirmwareTab.nodeKey("Fortinet", "switch", "FortiSwitch S108FF")]: true } });
    const root = renderCard();
    expect(root.querySelector(".fw-upload-btn")).toBeNull();
    expect(root.querySelector(".fw-image-del")).toBeNull();
    expect(root.querySelector(".fw-image-promote")).toBeNull();
    expect(root.querySelector(".fw-model-purge")).toBeNull();
    expect(root.querySelector(".fw-binding-edit")).toBeNull();
    // The facts are still all there to read.
    expect(Array.from(node(root, "Fortinet", "switch", "FortiSwitch S108FF").querySelectorAll(".fw-images tbody tr"))).toHaveLength(2);
  });
  it("at write: every verb, and 'Change login…' where a binding is set here", () => {
    level = "write";
    sb.PolarisFirmwareTab._setState({ expanded: { [sb.PolarisFirmwareTab.nodeKey("Fortinet", "switch", "FortiSwitch S108FF")]: true } });
    const root = renderCard();
    expect(root.querySelector(".fw-upload-btn")).not.toBeNull();
    expect(root.querySelector(".fw-image-del")).not.toBeNull();
    expect(root.querySelector(".fw-model-purge")).not.toBeNull();
    expect(text(node(root, "Fortinet").querySelector(".fw-binding-edit"))).toBe("Change login…");
    expect(text(node(root, "Fortinet", "switch").querySelector(".fw-binding-edit"))).toBe("Set login…");
  });
  it("the Repository tab is visible on firmware=read alone, never via isAdmin", () => {
    admin = false; level = "read";
    expect(sb._settingsTabVisible("firmware")).toBe(true);
    expect(sb._settingsTabVisible("identification")).toBe(false);
    expect(sb._settingsTabVisible("credentials")).toBe(true);
    level = "none";
    expect(sb._settingsTabVisible("firmware")).toBe(false);
    admin = true;
    expect(sb._settingsTabVisible("firmware")).toBe(false); // admin with the key at none still cannot see it
    expect(sb._settingsTabVisible("identification")).toBe(true);
  });
});

describe("the credential form's device-login mode", () => {
  it("offers 'Device admin login (form)', keeps the username/password groups for it, and reads back as form", () => {
    const host = sb.document.createElement("div");
    host.id = "cred-type-fields";
    sb.document.body.appendChild(host);
    host.innerHTML = sb.credHttpForm({ authMode: "form", username: "admin", password: "••••••••" });
    fixSelects(host);
    const sel = host.querySelector("#f-http-authmode") as HTMLSelectElement;
    expect(sel.value).toBe("form");
    expect(Array.from(sel.options).map((o) => o.value)).toContain("form");
    const user = host.querySelector("#f-http-user")!.closest("[data-http-auth]")!;
    expect(user.getAttribute("data-http-auth")!.split(" ")).toContain("form");
    sb.wireHttpAuthModeToggle();
    expect((host.querySelector("#f-http-user")!.closest("[data-http-auth]") as HTMLElement).style.display).toBe("");
    expect((host.querySelector("#f-http-token")!.closest("[data-http-auth]") as HTMLElement).style.display).toBe("none");
    // Its box says what it is for, and that a check will not take it.
    const box = host.querySelector('[data-http-auth="form"].alert')!;
    expect(text(box)).toMatch(/Server Settings → Repository/);
    expect(text(box)).toMatch(/HTTP-check widget will not accept it/);
    // The token carrier rides along empty; the server strips it for this mode.
    expect(sb.readCredentialForm("http")).toEqual({ authMode: "form", apiToken: "", username: "admin", password: "••••••••" });
    host.remove();
  });
  it("httpAuthModeOf returns a declared form, and credSummary names it a device login", () => {
    expect(sb.httpAuthModeOf({ authMode: "form", username: "a", password: "b" })).toBe("form");
    expect(sb.credSummary({ type: "http", config: { authMode: "form", username: "admin" } })).toBe("admin · device login");
  });
});
