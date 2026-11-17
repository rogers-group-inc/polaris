/**
 * tests/unit/modalTitleNameDom.test.ts — an "Edit …" dialog names what it is
 * editing: "Edit Path Monitor — RGILink Auth".
 *
 * One hook in app-modals.js (`_wireModalTitleName`) serves the shared
 * openModal and every stacked buildOverlay, so these assertions hold the
 * contract for all edit dialogs at once: the name rides the title once set,
 * follows the field as it is retyped, and leaves Add / New dialogs and
 * self-named titles alone.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Window } from "happy-dom";
import { appFileSource } from "./_appSource.js";

const SRC = appFileSource("app-modals.js");
const SEP = " — ";

let win: InstanceType<typeof Window>;
let w: Record<string, any>;

function title(): string {
  return win.document.querySelector("#modal-overlay .modal-header h3")!.textContent || "";
}

function type(el: any, value: string): void {
  el.value = value;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
}

beforeEach(() => {
  win = new Window();
  w = win as unknown as Record<string, any>;
  (win as any).eval(
    'function escapeHtml(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){' +
      ' return {"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"}[c]; }); }\n' +
      SRC,
  );
});

afterEach(async () => {
  await win.happyDOM.close();
});

describe("edit-modal title carries the item name", () => {
  it("appends the name already in the form when the dialog opens", () => {
    w.openModal("Edit Path Monitor", '<input type="text" id="pc-name" value="RGILink Auth">', "");
    expect(title()).toBe("Edit Path Monitor" + SEP + "RGILink Auth");
  });

  it("follows the name field as it is retyped, and drops it when cleared", () => {
    w.openModal("Edit Tag", '<input type="text" id="f-tag-name" value="core">', "");
    const input = win.document.getElementById("f-tag-name");
    type(input, "  edge  ");
    expect(title()).toBe("Edit Tag" + SEP + "edge");
    type(input, "");
    expect(title()).toBe("Edit Tag");
  });

  it("picks up a value the caller pins after openModal returns", async () => {
    w.openModal("Edit automation", '<input type="text" id="aw-name">', "");
    (win.document.getElementById("aw-name") as any).value = "WAN down";
    await new Promise((r) => setTimeout(r, 5));
    expect(title()).toBe("Edit automation" + SEP + "WAN down");
  });

  it("prefers a field marked data-title-name, and skips username / save-as fields", () => {
    w.openModal(
      "Edit Asset",
      '<input type="text" id="f-username" value="svc">' +
        '<input type="text" id="fmg-save-name" value="preset">' +
        '<input type="text" id="f-hostname" data-title-name value="server-01">',
      "",
    );
    expect(title()).toBe("Edit Asset" + SEP + "server-01");
  });

  it("leaves Add / New dialogs and self-named titles alone", () => {
    w.openModal("Add Path Monitor", '<input type="text" id="pc-name" value="x">', "");
    expect(title()).toBe("Add Path Monitor");
    w.openModal("Edit Description" + SEP + "sw-01", '<input type="text" id="f-name" value="y">', "");
    expect(title()).toBe("Edit Description" + SEP + "sw-01");
  });

  it("does not leak the previous dialog's listener into the next one", () => {
    w.openModal("Edit Tag", '<input type="text" id="f-tag-name" value="a">', "");
    w.openModal("Add Tag", '<input type="text" id="f-tag-name" value="">', "");
    type(win.document.getElementById("f-tag-name"), "b");
    expect(title()).toBe("Add Tag");
  });

  it("works on a stacked buildOverlay dialog too", () => {
    const ov = w.buildOverlay(1300, "Edit alert group", '<input type="text" id="ag-name" value="Core switches">', "", null, false);
    const h3 = ov.overlay ? ov.overlay.querySelector(".modal-header h3") : win.document.querySelector('.modal-overlay[style*="1300"] h3');
    expect(h3.textContent).toBe("Edit alert group" + SEP + "Core switches");
  });
});
