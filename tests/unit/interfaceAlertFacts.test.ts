/**
 * tests/unit/interfaceAlertFacts.test.ts
 *
 * The default alert email on an INTERFACE alert leaves the device facts out —
 * IP, connected switch / AP, location, model, description. The alert is about
 * a port; the Interface row and the LLDP block are what the reader needs, and
 * the device rows were the same filler the device charts were.
 *
 * Driven through buildComposedEmail, because the behaviour is a property of
 * the COMPOSE pass: the tokens are blanked for our default body only, and the
 * existing empty-row pruning is what makes the rows disappear.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { buildComposedEmail, defaultBodyContext } from "../../src/services/notificationRecipientService.js";
import { buildTemplateContext } from "../../src/utils/notificationTemplate.js";

const ctxFor = (metric: string) =>
  buildTemplateContext({
    asset: "WESTON-124F-1",
    metric,
    dimension: "wan1",
    dimensionLabel: "Interface",
    severity: "critical",
    message: "wan1 is down",
    triggerSummary: "Interface oper status on wan1 is down",
    time: new Date("2026-09-26T15:00:00Z"),
    ruleName: "WAN down",
    assetDetail: {
      id: "a-1",
      ipAddress: "10.20.30.40",
      location: "Weston quarry",
      manufacturer: "Fortinet",
      model: "FortiGate-60F",
      description: "Scale house firewall",
      lastSeenSwitch: "CORE-SW-1",
    },
  });

describe("the default body on an interface alert", () => {
  it("drops the device facts from both bodies", () => {
    const email = buildComposedEmail({}, ctxFor("ifOperStatus"));
    for (const body of [email.html!, email.text]) {
      expect(body).not.toContain("10.20.30.40");
      expect(body).not.toContain("Weston quarry");
      expect(body).not.toContain("FortiGate-60F");
      expect(body).not.toContain("Scale house firewall");
      expect(body).not.toContain("CORE-SW-1");
    }
    expect(email.html).not.toContain("IP address");
    expect(email.html).not.toContain(">Model<");
  });

  it("keeps which device, which port, and the automation", () => {
    const email = buildComposedEmail({}, ctxFor("ifInErrorRate"));
    expect(email.subject).toContain("WESTON-124F-1");
    expect(email.html).toContain("WESTON-124F-1");
    expect(email.html).toContain("wan1");
    expect(email.html).toContain("WAN down");
    expect(email.html).not.toContain("10.20.30.40");
  });

  it("leaves a device alert's facts alone", () => {
    const email = buildComposedEmail({}, ctxFor("cpuPct"));
    expect(email.html).toContain("10.20.30.40");
    expect(email.html).toContain("FortiGate-60F");
    expect(email.text).toContain("Weston quarry");
  });

  it("leaves an operator's own body alone — they asked for {asset.ip}", () => {
    const email = buildComposedEmail(
      { bodyTextTemplate: "Port {dimension} on {asset} ({asset.ip})", bodyHtmlTemplate: "<p>{asset.ip}</p>" },
      ctxFor("ifOperStatus"),
    );
    expect(email.text).toContain("10.20.30.40");
    expect(email.html).toContain("10.20.30.40");
  });

  it("returns the context untouched when nothing needs hiding", () => {
    const ctx = ctxFor("monitorStatus");
    expect(defaultBodyContext(ctx)).toBe(ctx);
  });
});
