/**
 * tests/unit/assetIpRevertDom.test.ts — "Revert to discovered IP" under a
 * pinned (or blank-pinned) IP field in the asset edit form
 * (public/js/assets.js → _wireIpRevertLink).
 *
 * Clearing the field now pins the asset to NO address, so the link is the one
 * way back to what discovery reports. It marks the field; getAssetFormData
 * then sends `ipRevertToDiscovered`. Typing an address cancels the revert.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const lines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

const g = globalThis as Record<string, any>;

beforeEach(() => {
  document.body.innerHTML =
    '<input id="f-ipAddress" data-override-field="1" value="10.0.0.5">' +
    '<p id="f-ipRevert-wrap"><a href="#" id="f-ipRevert">Revert to discovered IP</a></p>';
  // eslint-disable-next-line no-eval
  eval(fnSrc("_wireIpRevertLink") + "\nglobalThis._wireIpRevertLink = _wireIpRevertLink;");
  g._wireIpRevertLink();
});

describe("_wireIpRevertLink", () => {
  it("marks the field for a revert, empties it, and says what will happen", () => {
    (document.getElementById("f-ipRevert") as HTMLAnchorElement).click();
    const input = document.getElementById("f-ipAddress") as HTMLInputElement;
    expect(input.getAttribute("data-ip-revert")).toBe("1");
    expect(input.value).toBe("");
    expect(document.getElementById("f-ipRevert-wrap")!.textContent).toMatch(/revert to the discovered address on save/i);
  });

  it("is cancelled by typing an address", () => {
    (document.getElementById("f-ipRevert") as HTMLAnchorElement).click();
    const input = document.getElementById("f-ipAddress") as HTMLInputElement;
    input.value = "10.0.0.9";
    input.dispatchEvent(new Event("input"));
    expect(input.hasAttribute("data-ip-revert")).toBe(false);
  });

  it("does nothing when the form has no pinned field", () => {
    document.body.innerHTML = '<input id="f-ipAddress">';
    expect(() => g._wireIpRevertLink()).not.toThrow();
  });
});
