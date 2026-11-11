/**
 * tests/unit/fibreChannelHostWwn.test.ts
 *
 * Business rule 156, the host side: the WWN a server reports about its own
 * HBAs, in the three spellings its sources use, and the match it makes.
 *
 *   - Linux sysfs `0x10000090fa1b2c3d`, Windows bare hex, colon / dash forms;
 *   - vSphere's xsd:long, a SIGNED decimal (a WWN whose top bit is set is
 *     negative) — `wwnFromVimLong`;
 *   - all-zero and all-ones (sysfs's "not attached" fabric name) are no WWN;
 *   - a WWN claimed by one asset matches it; by two, nothing;
 *   - vCenter's hostBusAdapter array yields only the FC entries.
 */

import { describe, it, expect } from "vitest";
import { normalizeWwn, wwnFromVimLong, pickWwnMatch } from "../../src/utils/fibreChannel.js";
import { parseHostFcHbas } from "../../src/services/vcenterService.js";

describe("normalizeWwn", () => {
  it("reads every host spelling to one form", () => {
    for (const raw of ["0x10000090fa1b2c3d", "10000090FA1B2C3D", "10:00:00:90:FA:1B:2C:3D", "10-00-00-90-fa-1b-2c-3d"]) {
      expect(normalizeWwn(raw)).toBe("10:00:00:90:fa:1b:2c:3d");
    }
  });

  it("refuses non-WWNs and the placeholder values", () => {
    for (const raw of ["", null, "0x10", "zz000090fa1b2c3d", "0x0000000000000000", "0xffffffffffffffff"]) {
      expect(normalizeWwn(raw as string | null)).toBeNull();
    }
  });
});

describe("wwnFromVimLong", () => {
  it("reads a positive and a two's-complement negative xsd:long", () => {
    expect(wwnFromVimLong("1152922127278222397")).toBe("10:00:00:90:fa:1b:2c:3d");
    expect(wwnFromVimLong("5929714009249558537")).toBe("52:4a:93:79:74:fa:30:09");
    expect(wwnFromVimLong("-6917529027641081855")).toBe("a0:00:00:00:00:00:00:01");
  });

  it("refuses anything that is not an integer", () => {
    expect(wwnFromVimLong("abc")).toBeNull();
    expect(wwnFromVimLong("")).toBeNull();
    expect(wwnFromVimLong("0")).toBeNull();
  });
});

describe("pickWwnMatch", () => {
  const rows = [
    { assetId: "esx01", portWwn: "10:00:00:00:00:00:00:01" },
    { assetId: "esx01", portWwn: "10:00:00:00:00:00:00:01" },
    { assetId: "a", portWwn: "10:00:00:00:00:00:00:02" },
    { assetId: "b", portWwn: "10:00:00:00:00:00:00:02" },
  ];

  it("matches the one asset reporting the WWN, from any number of its sources", () => {
    expect(pickWwnMatch("10:00:00:00:00:00:00:01", rows)).toBe("esx01");
  });

  it("is no match when two assets claim it, none does, or it is the switch", () => {
    expect(pickWwnMatch("10:00:00:00:00:00:00:02", rows)).toBeNull();
    expect(pickWwnMatch("10:00:00:00:00:00:00:09", rows)).toBeNull();
    expect(pickWwnMatch("10:00:00:00:00:00:00:01", rows, "esx01")).toBeNull();
  });
});

describe("parseHostFcHbas", () => {
  const block =
    "<objects><obj type=\"HostSystem\">host-12</obj>" +
    "<propSet><name>config.storageDevice.hostBusAdapter</name><val xsi:type=\"ArrayOfHostHostBusAdapter\">" +
      "<HostHostBusAdapter xsi:type=\"HostBlockHba\"><key>k0</key><device>vmhba0</device><status>unknown</status><model>AHCI</model><driver>vmw_ahci</driver></HostHostBusAdapter>" +
      "<HostHostBusAdapter xsi:type=\"HostFibreChannelHba\"><key>k2</key><device>vmhba2</device><bus>59</bus><status>online</status>" +
        "<model>Emulex SN1610E2P</model><driver>lpfc</driver><pci>0000:3b:00.0</pci>" +
        "<portWorldWideName>1152922127278222397</portWorldWideName><nodeWorldWideName>2305843631885069373</nodeWorldWideName>" +
        "<portType>fabric</portType><speed>16</speed></HostHostBusAdapter>" +
      "<HostHostBusAdapter xsi:type=\"HostFibreChannelHba\"><key>k3</key><device>vmhba3</device><status>link-n/a</status>" +
        "<portWorldWideName>0</portWorldWideName><speed>0</speed></HostHostBusAdapter>" +
    "</val></propSet></objects>";

  it("yields the FC adapters with their WWNs, skipping other kinds and unreadable WWNs", () => {
    expect(parseHostFcHbas(block)).toEqual([
      {
        device: "vmhba2",
        portWwn: "10:00:00:90:fa:1b:2c:3d",
        nodeWwn: "20:00:00:90:fa:1b:2c:3d",
        status: "online",
        speed: "16 Gbit",
        portType: "fabric",
        model: "Emulex SN1610E2P",
        driver: "lpfc",
      },
    ]);
  });

  it("is null when the property was not published, [] when it holds no FC adapter", () => {
    expect(parseHostFcHbas("<objects></objects>")).toBeNull();
    expect(parseHostFcHbas(
      "<propSet><name>config.storageDevice.hostBusAdapter</name><val xsi:type=\"ArrayOfHostHostBusAdapter\"></val></propSet>",
    )).toEqual([]);
  });
});
