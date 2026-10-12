/**
 * tests/unit/assetRemoteAccessRdp.test.ts — the asset slide-over's remote-access
 * verbs for a SERVER (public/js/assets.js).
 *
 * Firewalls / switches / APs offer Open HTTPS + Open SSH off the `allowaccess`
 * list captured during FortiGate discovery. A server has no such list and never
 * will — nothing reads a Windows or Linux host's management surface — so its
 * verbs come from the asset TYPE instead: Open RDP + Open SSH, offered
 * optimistically the way the best-effort FortiSwitch path already is.
 *
 * Three things this pins, each of which breaks silently:
 *  - a server must NOT get Open HTTPS (its :443 is the application, not a
 *    management UI) and a Fortinet device must NOT get Open RDP;
 *  - the type-driven path still requires an address to dial, so an IP-less
 *    server contributes no buttons rather than ones pointing at "null";
 *  - the header dropdowns must not carry `.drop-up` — the group renders at the
 *    TOP of the panel, so an up-opening menu lands off-panel
 *    (tests/unit/assetPanelHeaderActionsDom.test.ts owns the placement half).
 *
 * assets.js is a ~21k-line browser script with no module boundary, so the
 * functions under test are sliced out by name and eval'd — the approach of
 * tests/unit/assetRowMenu.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = assetsLines.findIndex(
    (l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`),
  );
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

let mgmtAccess: (a: any) => any;
let buttonsHTML: (a: any) => string;
let rdpFileBody: (host: string, user: string) => string;
let rdpAction: () => string;
let doRdpLaunch: (ip: string, action: string) => void;
let rdpUri: (host: string, user: string) => string;

const server = (over: Record<string, unknown> = {}) => ({
  id: "s1", hostname: "app-01", status: "active", assetType: "server", ipAddress: "10.0.0.9", ...over,
});
const firewall = (over: Record<string, unknown> = {}) => ({
  id: "f1", hostname: "fgt-01", status: "active", assetType: "firewall", ipAddress: "10.0.0.1",
  managementAccess: { mgmtIp: "10.0.0.1", protocols: ["https", "ssh"], https: true, ssh: true },
  ...over,
});

beforeEach(() => {
  g.escapeHtml = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]!);
  g.showToast = vi.fn();
  g.copyTextToClipboard = vi.fn(async () => true);
  localStorage.clear();

  for (const fn of ["_assetMgmtAccess", "_managementAccessButtonsHTML", "_rdpFileBody", "_rdpAction", "_rdpUser", "_rdpUri", "_connectHostOk", "_connectUserOk", "_connectRefused", "_doRdpLaunch"]) {
    // eslint-disable-next-line no-eval
    (0, eval)(fnSrc(fn));
  }
  mgmtAccess = g._assetMgmtAccess;
  buttonsHTML = g._managementAccessButtonsHTML;
  rdpFileBody = g._rdpFileBody;
  rdpAction = g._rdpAction;
  doRdpLaunch = g._doRdpLaunch;
  rdpUri = g._rdpUri;
});

describe("_assetMgmtAccess — type-driven verbs", () => {
  it("gives a server RDP + SSH and withholds HTTPS", () => {
    const info = mgmtAccess(server());
    expect(info).toMatchObject({ mgmtIp: "10.0.0.9", showRdp: true, showSsh: true, showHttps: false });
    // Nothing read this host's access config, so the options menu says so.
    expect(info.unknown).toBe(true);
  });

  it("never gives a Fortinet device RDP", () => {
    expect(mgmtAccess(firewall())).toMatchObject({ showHttps: true, showSsh: true, showRdp: false });
    // Including the unreadable-switch path, where both Fortinet verbs are optimistic.
    const sw = mgmtAccess({ assetType: "switch", ipAddress: "10.0.0.2", managementAccess: { mgmtIp: null, protocols: null, https: false, ssh: false } });
    expect(sw).toMatchObject({ showHttps: true, showSsh: true, showRdp: false });
  });

  it("leaves every other type alone", () => {
    // Workstations deliberately stay out: an operator reaches a server from
    // inventory, and two dead verbs on every endpoint row is how a menu stops
    // being read.
    expect(mgmtAccess({ assetType: "workstation", ipAddress: "10.0.0.50" })).toBeNull();
    expect(mgmtAccess({ assetType: "printer", ipAddress: "10.0.0.51" })).toBeNull();
    expect(mgmtAccess(null)).toBeNull();
  });

  it("needs an address to dial", () => {
    expect(mgmtAccess(server({ ipAddress: null }))).toBeNull();
  });
});

describe("_managementAccessButtonsHTML", () => {
  it("renders an Open RDP split button for a server, no Open HTTPS", () => {
    const html = buttonsHTML(server());
    expect(html).toContain('id="btn-asset-rdp"');
    expect(html).toContain(">Open RDP<");
    expect(html).toContain('id="btn-asset-rdp-caret"');
    expect(html).toContain('data-rdp="file"');
    expect(html).toContain('data-rdp="uri"');
    expect(html).toContain('data-rdp="copy"');
    expect(html).toContain('data-rdp="setuser"');
    expect(html).toContain('id="btn-asset-ssh"');
    expect(html).not.toContain('id="btn-asset-https"');
  });

  it("says the access state is unverified on a type-inferred device", () => {
    expect(buttonsHTML(server())).toContain("Access state unverified");
    // A Fortinet device whose list WAS read makes no such claim.
    expect(buttonsHTML(firewall())).not.toContain("Access state unverified");
  });

  it("renders no RDP button for a Fortinet device", () => {
    const html = buttonsHTML(firewall());
    expect(html).toContain('id="btn-asset-https"');
    expect(html).not.toContain('id="btn-asset-rdp"');
  });

  it("keeps the dropdowns opening DOWN — the group is in the header", () => {
    expect(buttonsHTML(server())).not.toContain("drop-up");
  });

  it("renders nothing for an asset with no management surface", () => {
    expect(buttonsHTML({ assetType: "workstation", ipAddress: "10.0.0.50" })).toBe("");
  });
});

describe("_rdpFileBody", () => {
  it("writes a CRLF descriptor mstsc can open", () => {
    expect(rdpFileBody("10.0.0.9", "")).toBe(
      "full address:s:10.0.0.9\r\nscreen mode id:i:2\r\nprompt for credentials:i:1\r\n",
    );
  });

  it("carries the operator's default user when one is set", () => {
    expect(rdpFileBody("10.0.0.9", "CORP\\dmoore")).toContain("username:s:CORP\\dmoore");
  });

  it("never writes a credential — the client prompts", () => {
    const body = rdpFileBody("10.0.0.9", "CORP\\dmoore");
    expect(body).toContain("prompt for credentials:i:1");
    expect(body).not.toMatch(/password/i);
  });
});

describe("_rdpAction / _doRdpLaunch", () => {
  it("defaults to the .rdp FILE — mstsc registers no URL scheme", () => {
    expect(rdpAction()).toBe("file");
    localStorage.setItem("polaris-rdp-action", "nonsense");
    expect(rdpAction()).toBe("file");
    localStorage.setItem("polaris-rdp-action", "uri");
    expect(rdpAction()).toBe("uri");
    localStorage.setItem("polaris-rdp-action", "copy");
    expect(rdpAction()).toBe("copy");
  });

  it("copies an mstsc command, which takes no username", () => {
    localStorage.setItem("polaris-rdp-user", "CORP\\dmoore");
    doRdpLaunch("10.0.0.9", "copy");
    expect(g.copyTextToClipboard).toHaveBeenCalledWith("mstsc /v:10.0.0.9");
  });

  // Scan finding F257 / rule 105: the address went into the .rdp body and the
  // pasted command unchecked, so a line break added lines to the file and a `;`
  // added a command to a line the operator pasted into a shell.
  it.each([
    "10.0.0.9\r\nenable credssp support:i:0",
    "10.0.0.9\nusername:s:x",
    "10.0.0.9; rm -rf ~",
    "10.0.0.9 && calc",
    "host name",
    "$(id)",
    "`id`",
    "",
  ])("launches nothing for the address %j", (host) => {
    for (const action of ["copy", "file", "uri"]) {
      g.showToast.mockClear();
      g.copyTextToClipboard.mockClear();
      doRdpLaunch(host, action);
      expect(g.copyTextToClipboard).not.toHaveBeenCalled();
      expect(g.showToast).toHaveBeenCalledWith(expect.stringContaining("cannot be used"), "error");
    }
  });

  it("launches nothing when the default user carries a line break", () => {
    localStorage.setItem("polaris-rdp-user", "CORP\\x\r\nalternate shell:s:cmd.exe");
    doRdpLaunch("10.0.0.9", "copy");
    expect(g.copyTextToClipboard).not.toHaveBeenCalled();
    expect(g.showToast).toHaveBeenCalledWith(expect.stringContaining("username"), "error");
  });

  it("still accepts every ordinary address form", () => {
    for (const host of ["10.0.0.9", "fd00::5", "fe80::1%eth0", "[fd00::5]", "app-01.corp.example.com"]) {
      expect(g._connectHostOk(host)).toBe(true);
    }
    for (const user of ["", "admin", "CORP\\jdoe", "jdoe@example.com", "svc_polaris-1"]) {
      expect(g._connectUserOk(user)).toBe(true);
    }
  });

  it("builds Microsoft's RDP URI, folding in the default user", () => {
    // The URI half is pure (`_rdpUri`) precisely so it can be asserted without
    // navigating the test DOM to an unknown scheme.
    expect(rdpUri("10.0.0.9", "")).toBe("rdp://full%20address=s:10.0.0.9:3389");
    expect(rdpUri("10.0.0.9", "CORP\\dmoore")).toBe(
      "rdp://full%20address=s:10.0.0.9:3389&username=s:CORP%5Cdmoore",
    );
  });
});

describe("_doSshLaunch: the same refusal on the SSH side (scan finding F257)", () => {
  beforeEach(() => {
    for (const fn of ["_sshPref", "_sshUser", "_sshTarget", "_doSshLaunch"]) {
      // eslint-disable-next-line no-eval
      (0, eval)(fnSrc(fn));
    }
  });

  it.each(["10.0.0.9; rm -rf ~", "10.0.0.9\nid", "10.0.0.9 -oProxyCommand=id", "$(id)"])(
    "copies and launches nothing for the address %j",
    (host) => {
      g._doSshLaunch(host, "copy");
      expect(g.copyTextToClipboard).not.toHaveBeenCalled();
      expect(g.showToast).toHaveBeenCalledWith(expect.stringContaining("cannot be used"), "error");
    },
  );

  it("refuses a default user that would add words to the pasted command", () => {
    localStorage.setItem("polaris-ssh-user", "root -oProxyCommand=id");
    g._doSshLaunch("10.0.0.9", "copy");
    expect(g.copyTextToClipboard).not.toHaveBeenCalled();
  });

  it("copies an ordinary command", () => {
    localStorage.setItem("polaris-ssh-user", "jdoe");
    g._doSshLaunch("10.0.0.9", "copy");
    expect(g.copyTextToClipboard).toHaveBeenCalledWith("ssh jdoe@10.0.0.9");
  });
});
