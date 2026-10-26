/**
 * tests/unit/reservedAddressCollisionMessage.test.ts — the "Push failed" text a
 * reservation push gets when the FortiGate already reserves the IP or the MAC
 * (src/services/reservationPushService.ts → reservedAddressCollisionMessage).
 *
 * The incident: a managed switch's push failed with "already has a reservation
 * for MAC … If this entry is not in Polaris, run discovery …". Polaris had
 * written that entry itself, on the switch's other address, and the message
 * named neither fact — so the operator went looking for a missing row.
 */

import { describe, it, expect } from "vitest";
import { reservedAddressCollisionMessage, classifyPushError } from "../../src/services/reservationPushService.js";
import { AppError } from "../../src/utils/errors.js";

const MAC = "1c:d1:1a:6d:57:9b";

describe("reservedAddressCollisionMessage", () => {
  it("names the address the MAC is already reserved on, and that Polaris wrote it", () => {
    const msg = reservedAddressCollisionMessage(
      { id: 4, ip: "172.23.61.131", mac: MAC, description: "Polaris/system:auto-reserve: SR12FPTY26000444" },
      { mac: MAC },
    );
    expect(msg).toContain(`reservation for MAC ${MAC} on this scope at 172.23.61.131`);
    expect(msg).toContain("Polaris wrote that entry, so it is the reservation for 172.23.61.131 in Polaris");
    expect(msg).toContain("release it there to free the MAC");
    expect(msg).not.toContain("If this entry is not in Polaris");
    expect(msg).not.toContain("run discovery");
  });

  it("recognises the description Polaris writes with no user in scope", () => {
    const msg = reservedAddressCollisionMessage(
      { id: 7, ip: "10.0.0.9", mac: MAC, description: "Polaris: printer-2f" },
      { mac: MAC },
    );
    expect(msg).toContain("Polaris wrote that entry");
  });

  it("points at discovery or the gate for an entry Polaris did not write", () => {
    const msg = reservedAddressCollisionMessage(
      { id: 9, ip: "10.0.0.9", mac: MAC, description: "added by hand" },
      { mac: MAC },
    );
    expect(msg).toContain("Polaris did not write that entry");
    expect(msg).toContain("run discovery");
    expect(msg).toContain("remove it from the FortiGate to free the MAC");
    // A description that merely mentions Polaris is not one Polaris wrote.
    expect(reservedAddressCollisionMessage({ id: 1, ip: "10.0.0.9", description: "moved from Polaris" }, { mac: MAC }))
      .toContain("Polaris did not write that entry");
  });

  it("does not repeat the address on an IP collision", () => {
    const msg = reservedAddressCollisionMessage(
      { id: 5, ip: "10.0.0.5", mac: "aa:bb:cc:dd:ee:ff", description: "Polaris/alice: lab box" },
      { ip: "10.0.0.5" },
    );
    expect(msg).toMatch(/^FortiGate already has a reservation for 10\.0\.0\.5 on this scope \(entry id 5,/);
    expect(msg).toContain("free the IP");
  });

  it("still classifies as a permanent failure", () => {
    const msg = reservedAddressCollisionMessage({ id: 4, ip: "10.0.0.1", mac: MAC }, { mac: MAC });
    expect(classifyPushError(new AppError(409, msg))).toBe("permanent");
  });
});
