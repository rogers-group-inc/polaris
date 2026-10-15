/**
 * tests/unit/conditionBuilderDom.test.ts — the shared device-condition builder
 * (public/js/condition-builder.js).
 *
 * It was extracted out of the automation wizard so the address book's contact
 * device filter could use the same tree, which means two surfaces now depend on
 * its round-trip: what groupHtml() renders, collect() must read back verbatim.
 * These tests pin that round-trip, the depth cap, and the validation messages —
 * the parts a caller can't check for itself.
 *
 * Loaded by eval into a happy-dom Window, the automationsWizardDom pattern.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { fixSelects } from "../fixtures/happyDomSelects.js";

type Tree = { op: string; children: unknown[] };
type Builder = {
  groupHtml: (g: unknown, d: number) => string;
  ruleRowHtml: (r: unknown) => string;
  collect: (el: unknown) => Tree;
  validate: (t: unknown) => string | null;
  seedIfEmpty: (el: unknown) => void;
  wire: (panel: unknown, sel: string) => void;
  maxDepth: number;
};

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let toasts: string[];
let changes: number;
let make: (over?: Record<string, unknown>) => Builder;

const META = {
  groupOps: ["and", "or", "none", "notAll"],
  groupOpLabels: { and: "All child conditions", or: "At least one", none: "None", notAll: "Not all" },
  operatorLabels: { equals: "is equal to", contains: "contains", has: "is applied", inCidr: "is within" },
  fields: [
    { field: "assetType", label: "Device type", ops: ["equals"], optionsFrom: "assetTypes" },
    { field: "hostname", label: "Hostname", ops: ["equals", "contains"], optionsFrom: null },
    { field: "tag", label: "Tag", ops: ["has"], optionsFrom: "tags" },
    { field: "subnet", label: "Subnet / IP", ops: ["inCidr"], optionsFrom: "subnets" },
    { field: "ipBlock", label: "IP block", ops: ["inCidr"], optionsFrom: "ipBlocks" },
  ],
  maxDepth: 5,
};

/** Render a tree into a detached root the way a caller does. fixSelects repairs
 *  happy-dom's `<option selected>` parsing so we test the builder, not the DOM
 *  engine — see tests/fixtures/happyDomSelects.ts. */
function mount(builder: Builder, tree: unknown): HTMLElement {
  const host = doc.createElement("div");
  host.id = "cond-root";
  host.innerHTML = builder.groupHtml(tree, 0);
  doc.body.appendChild(host);
  fixSelects(host as unknown as { querySelectorAll: (s: string) => Iterable<unknown> });
  return host as unknown as HTMLElement;
}
function rootGroup(host: HTMLElement) {
  return host.querySelector(":scope > .scg-group");
}

beforeAll(() => {
  const win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  toasts = [];
  changes = 0;
  (win as unknown as Record<string, unknown>).escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  (win as unknown as Record<string, unknown>).showToast = (msg: string) => { toasts.push(msg); };

  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/condition-builder.js"), "utf8"));

  const api = (win as unknown as Record<string, { create: (o: unknown) => Builder }>).PolarisConditionBuilder;
  make = (over) =>
    api.create({
      meta: META,
      valueOptions: (field: string) =>
        field === "assetType" ? [{ value: "switch", label: "Switch" }, { value: "server", label: "Server" }] : [],
      onChange: () => { changes++; },
      ...(over || {}),
    });
});

describe("condition-builder round-trip", () => {
  it("renders a nested tree and collects back exactly what went in", () => {
    const b = make();
    const tree = {
      op: "and",
      children: [
        { field: "assetType", operator: "equals", value: "switch" },
        {
          op: "or",
          children: [
            { field: "tag", operator: "has", value: "region:Ashfield" },
            { field: "hostname", operator: "contains", value: "-61F-" },
          ],
        },
      ],
    };
    const host = mount(b, tree);
    expect(b.collect(rootGroup(host))).toEqual(tree);
  });

  it("keeps sibling order — DOM order IS the tree, which is what makes a drag free", () => {
    const b = make();
    const host = mount(b, {
      op: "and",
      children: [
        { field: "hostname", operator: "equals", value: "a" },
        { field: "hostname", operator: "equals", value: "b" },
        { field: "hostname", operator: "equals", value: "c" },
      ],
    });
    const kids = host.querySelector(".scg-children")!;
    kids.appendChild(kids.children[0]); // move "a" to the end, as a drop would
    const collected = b.collect(rootGroup(host)) as { children: { value: string }[] };
    expect(collected.children.map((c) => c.value)).toEqual(["b", "c", "a"]);
  });

  it("trims whitespace out of values on collect", () => {
    const b = make();
    const host = mount(b, { op: "and", children: [{ field: "hostname", operator: "equals", value: "x" }] });
    (host.querySelector(".scr-value") as HTMLInputElement).value = "  padded  ";
    const collected = b.collect(rootGroup(host)) as { children: { value: string }[] };
    expect(collected.children[0].value).toBe("padded");
  });

  it("offers + Group until the depth cap, and not at the last allowed level", () => {
    const b = make();
    const deep = mount(b, { op: "and", children: [] });
    expect(deep.querySelector(".scg-add-group")).not.toBeNull();
    const atCap = doc.createElement("div");
    atCap.innerHTML = b.groupHtml({ op: "and", children: [] }, META.maxDepth - 1);
    expect(atCap.querySelector(".scg-add-group")).toBeNull();
  });
});

describe("condition-builder validation", () => {
  it("passes a fully-filled tree", () => {
    const b = make();
    expect(b.validate({ op: "and", children: [{ field: "hostname", operator: "equals", value: "sw1" }] })).toBeNull();
  });

  it("refuses an empty group rather than saving something that matches everything", () => {
    const b = make();
    expect(b.validate({ op: "and", children: [] })).toMatch(/group is empty/i);
    expect(
      b.validate({ op: "and", children: [{ op: "or", children: [] }] }),
    ).toMatch(/group is empty/i);
  });

  it("refuses a valueless row", () => {
    const b = make();
    expect(b.validate({ op: "and", children: [{ field: "hostname", operator: "equals", value: "" }] }))
      .toMatch(/needs a value/i);
  });

  it("refuses a subnet value that isn't CIDR-ish, and accepts one that is", () => {
    const b = make();
    expect(b.validate({ op: "and", children: [{ field: "subnet", operator: "inCidr", value: "the DMZ" }] }))
      .toMatch(/does not look like a CIDR/i);
    expect(b.validate({ op: "and", children: [{ field: "subnet", operator: "inCidr", value: "10.20.0.0/16" }] }))
      .toBeNull();
    expect(b.validate({ op: "and", children: [{ field: "subnet", operator: "inCidr", value: "10.20.0.7" }] }))
      .toBeNull(); // a bare IP is a /32
  });

  // The IP block picker offers "name — CIDR" and stores the CIDR half. Typing
  // the block's NAME is the mistake the message has to name, or the operator
  // reads "Subnet ... does not look like a CIDR" about a row that says IP block.
  it("refuses an IP block value that isn't CIDR-ish, naming the field", () => {
    const b = make();
    expect(b.validate({ op: "and", children: [{ field: "ipBlock", operator: "inCidr", value: "Corporate Core" }] }))
      .toMatch(/^IP block .*does not look like a CIDR/i);
    expect(b.validate({ op: "and", children: [{ field: "ipBlock", operator: "inCidr", value: "10.20.0.0/16" }] }))
      .toBeNull();
  });

  // Subnet / IP offers CIDR, Range and Name. The CIDR check must not refuse a
  // range or a subnet name — they are what those operators are FOR.
  it("checks a range as a range and lets a subnet name through", () => {
    const b = make();
    const row = (operator: string, value: string) => ({ op: "and", children: [{ field: "subnet", operator, value }] });
    expect(b.validate(row("inRange", "10.20.0.10-10.20.0.50"))).toBeNull();
    expect(b.validate(row("notInRange", "10.20.0.10-50"))).toBeNull();
    expect(b.validate(row("inRange", "10.20.0.0/24"))).toMatch(/should run first to last/i);
    expect(b.validate(row("inSubnetNamed", "Plant-*"))).toBeNull();
    expect(b.validate(row("notInSubnetNamed", "Office"))).toBeNull();
    expect(b.validate(row("inCidr", "Plant-*"))).toMatch(/does not look like a CIDR/i);
  });
});

describe("condition-builder Subnet / IP value kinds", () => {
  const SUBNET_META = {
    ...META,
    fields: [
      { field: "hostname", label: "Hostname", ops: ["equals"], optionsFrom: null },
      { field: "subnet", label: "Subnet / IP", ops: ["inCidr", "notInCidr", "inRange", "notInRange", "inSubnetNamed", "notInSubnetNamed"], optionsFrom: "subnets" },
    ],
  };
  const SUBNETS = [
    { value: "10.1.0.0/24", label: "Plant-A — 10.1.0.0/24", name: "Plant-A" },
    { value: "10.9.1.0/24", label: "Plant-A — 10.9.1.0/24", name: "Plant-A" }, // same name, two blocks
    { value: "10.2.0.0/24", label: "Office — 10.2.0.0/24", name: "Office" },
  ];

  function wired(rule: Record<string, string>) {
    const b = make({ meta: SUBNET_META, valueOptions: (field: string) => (field === "subnet" ? SUBNETS : []) });
    const panel = doc.createElement("div");
    const host = mount(b, { op: "and", children: [rule] });
    panel.appendChild(host);
    doc.body.appendChild(panel);
    b.wire(panel, "#cond-root");
    const op = host.querySelector(".scr-op") as HTMLSelectElement;
    const input = host.querySelector(".scr-value") as HTMLInputElement;
    const setOp = (v: string) => {
      op.value = v;
      op.dispatchEvent(new (g.window as { Event: typeof Event }).Event("change", { bubbles: true }));
    };
    return { host, op, input, setOp };
  }

  it("tells the operator what each kind of value looks like", () => {
    const { input, setOp } = wired({ field: "subnet", operator: "inCidr", value: "" });
    expect(input.placeholder).toMatch(/10\.20\.0\.0\/16/);
    setOp("inRange");
    expect(input.placeholder).toMatch(/10\.20\.0\.10-10\.20\.0\.50/);
    setOp("inSubnetNamed");
    expect(input.placeholder).toMatch(/wildcard/i);
  });

  it("clears the value when the KIND changes, and keeps it for a negation", () => {
    const { input, setOp } = wired({ field: "subnet", operator: "inCidr", value: "10.1.0.0/24" });
    setOp("notInCidr");
    expect(input.value).toBe("10.1.0.0/24");
    setOp("inSubnetNamed");
    expect(input.value).toBe("");
  });

  it("offers each subnet NAME once to a name rule, and nothing to a range", () => {
    const { host, input, setOp } = wired({ field: "subnet", operator: "inSubnetNamed", value: "" });
    input.dispatchEvent(new (g.window as { Event: typeof Event }).Event("input", { bubbles: true }));
    const items = Array.from(host.querySelectorAll(".aw-suggest-item")).map((el) => el.getAttribute("data-val"));
    expect(items).toEqual(["Plant-A", "Office"]);

    setOp("inRange");
    input.dispatchEvent(new (g.window as { Event: typeof Event }).Event("input", { bubbles: true }));
    expect(host.querySelectorAll(".aw-suggest-item")).toHaveLength(0);
  });
});

describe("condition-builder seeding", () => {
  it("seeds a starter row into an empty root so a revealed builder is editable", () => {
    const b = make();
    const host = mount(b, { op: "and", children: [] });
    expect(host.querySelectorAll(".scr-row").length).toBe(0);
    b.seedIfEmpty(host);
    expect(host.querySelectorAll(".scr-row").length).toBe(1);
  });

  it("leaves a populated root alone", () => {
    const b = make();
    const host = mount(b, { op: "and", children: [{ field: "hostname", operator: "equals", value: "sw1" }] });
    b.seedIfEmpty(host);
    expect(host.querySelectorAll(".scr-row").length).toBe(1);
  });
});

describe("condition-builder legacy folding", () => {
  it("folds a flat scope into a tree, using OR for a multi-value dimension", () => {
    const api = (g.window as unknown as Record<string, { legacyScopeToCondition: (s: unknown) => Tree }>)
      .PolarisConditionBuilder;
    const tree = api.legacyScopeToCondition({ assetTypes: ["switch"], tags: ["a", "b"] });
    expect(tree.op).toBe("and");
    expect(tree.children).toEqual([
      { field: "assetType", operator: "equals", value: "switch" },
      { op: "or", children: [
        { field: "tag", operator: "has", value: "a" },
        { field: "tag", operator: "has", value: "b" },
      ] },
    ]);
  });

  it("folds an empty scope to an empty AND group (= all devices)", () => {
    const api = (g.window as unknown as Record<string, { legacyScopeToCondition: (s: unknown) => Tree }>)
      .PolarisConditionBuilder;
    expect(api.legacyScopeToCondition({})).toEqual({ op: "and", children: [] });
  });
});
