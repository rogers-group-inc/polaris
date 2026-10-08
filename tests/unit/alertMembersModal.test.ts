/**
 * tests/unit/alertMembersModal.test.ts
 *
 * PolarisAlertMembers (public/js/alert-members-modal.js) — the list of the
 * components one GROUPED alert is made of (business rule 75), opened from the
 * Active Alerts widget and the asset Alerts tab.
 *
 * The properties under test:
 *   • it reads the alert's `members` snapshot and shows departures, because the
 *     snapshot keeps them on purpose — "which of these came back" is half the
 *     question;
 *   • still-affected first, worst severity first; recovered after;
 *   • a row already holding `members` is rendered without a fetch (the Alerts
 *     tab is gated assets:read and must not need alerts:read), an id is read
 *     through GET /alerts/:id;
 *   • the Automation column appears only when several automations contributed.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

interface Members { open: (a: unknown, o?: Record<string, unknown>) => Promise<void> }

let win: Window;
let doc: Window["document"];
let M: Members;
let modal: { title: string; body: string; footer: string } | null;
let fetched: string[];
let served: Record<string, unknown>;
let closed: number;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  win = new Window();
  doc = win.document;
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = doc;
  (0, eval)(readFileSync(resolve(here, "../../public/js/alert-members-modal.js"), "utf8"));
  M = (win as unknown as { PolarisAlertMembers: Members }).PolarisAlertMembers;
});

beforeEach(() => {
  modal = null;
  fetched = [];
  closed = 0;
  served = {};
  const w = win as unknown as Record<string, unknown>;
  w._alertSevRank = (s: string) => ({ notice: 1, info: 2, warning: 3, serious: 4, critical: 5 } as Record<string, number>)[s] || 0;
  w.openModal = (title: string, body: string, footer: string) => {
    modal = { title, body, footer };
    doc.body.innerHTML = '<div id="m">' + body + footer + "</div>";
  };
  w.closeModal = () => { closed++; };
  w.api = { alerts: { get: (id: string) => { fetched.push(id); return Promise.resolve(served); } } };
  w.showToast = () => {};
});

const member = (o: Record<string, unknown>) => ({
  key: "k", label: "k", ruleId: "r1", ruleName: "SLA loss", severity: "warning",
  joinedAt: "2026-10-08T15:32:00Z", ...o,
});

const rowText = () =>
  Array.from(doc.querySelectorAll("tbody tr")).map((tr: any) =>
    Array.from(tr.querySelectorAll("td")).map((td: any) => td.textContent.trim()));

describe("PolarisAlertMembers", () => {
  it("renders a row it already holds without fetching", async () => {
    await M.open({
      id: "a1", message: "SLA loss: 2 members", assetHostname: "fgt-1", ruleName: "SLA loss",
      members: [member({ key: "Microsoft|wan2", label: "Microsoft / wan2", value: "35" })],
    });
    expect(fetched).toEqual([]);
    expect(modal!.title).toBe("Alerts in this group");
    expect(modal!.body).toContain("Microsoft / wan2");
    expect(modal!.body).toContain("Grouped by device — SLA loss");
    expect(modal!.body).toContain("fgt-1");
  });

  it("reads the alert by id when that is all the caller has", async () => {
    served = { id: "a2", groupName: "Switch health", members: [member({ label: "port1" })] };
    await M.open("a2");
    expect(fetched).toEqual(["a2"]);
    expect(modal!.body).toContain("Alert group: Switch health");
  });

  it("lists the still-affected worst-first, then the recovered, most recent first", async () => {
    await M.open({
      id: "a3",
      members: [
        member({ label: "port3", severity: "warning" }),
        member({ label: "port1", severity: "critical" }),
        member({ label: "port9", severity: "critical", leftAt: "2026-10-08T16:00:00Z" }),
        member({ label: "port7", severity: "warning", leftAt: "2026-10-08T17:00:00Z" }),
      ],
    });
    expect(rowText().map((r) => r[1])).toEqual(["port1", "port3", "port7", "port9"]);
    expect(rowText()[2]![0]).toBe("Recovered");
    expect(modal!.body).toContain("2 still affected · 2 recovered");
  });

  it("adds the Automation column only when several automations contributed", async () => {
    await M.open({ id: "a4", members: [member({ label: "p1" }), member({ label: "p2" })] });
    expect(modal!.body).not.toContain("<th>Automation</th>");
    await M.open({ id: "a5", members: [member({ label: "p1" }), member({ label: "TMP1", ruleId: "r2", ruleName: "Temperature" })] });
    expect(modal!.body).toContain("<th>Automation</th>");
    expect(modal!.body).toContain("Temperature");
  });

  it("says so when an alert carries no component list", async () => {
    await M.open({ id: "a6", members: [] });
    expect(modal!.body).toContain("carries no component list");
  });

  it("offers Open device only when the caller gives one", async () => {
    let opened = 0;
    await M.open({ id: "a7", members: [member({})] }, { onOpenDevice: () => { opened++; } });
    (doc.getElementById("alert-members-device") as any).click();
    expect(opened).toBe(1);
    expect(closed).toBe(1);
    await M.open({ id: "a8", members: [member({})] });
    expect(doc.getElementById("alert-members-device")).toBeNull();
  });

  it("escapes what an operator or a device wrote", async () => {
    await M.open({ id: "a9", message: "<img src=x>", members: [member({ label: "<b>p</b>" })] });
    expect(modal!.body).not.toContain("<img");
    expect(modal!.body).not.toContain("<b>p</b>");
  });
});
