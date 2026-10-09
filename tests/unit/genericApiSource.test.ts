import { describe, it, expect } from "vitest";
import {
  GENERIC_API_LABEL,
  GENERIC_API_SOURCE_KIND,
  GENERIC_API_TYPE,
  genericApiExternalId,
  genericApiIdentityFromExternalId,
} from "../../src/utils/genericApiSource.js";
import { assetSourceKindFromIntegrationType } from "../../src/utils/pollingCompatibility.js";

describe("genericApiSource", () => {
  it("names the type, the source kind and the label the rest of the code keys on", () => {
    expect(GENERIC_API_TYPE).toBe("genericapi");
    expect(GENERIC_API_SOURCE_KIND).toBe("generic-api");
    expect(GENERIC_API_LABEL).toBe("Generic API");
    // The Integration.type literal IS the polling source kind.
    expect(assetSourceKindFromIntegrationType(GENERIC_API_TYPE)).toBe(GENERIC_API_TYPE);
  });

  it("scopes an identity to its integration, so two feeds numbering from 1 never collide", () => {
    expect(genericApiExternalId("a", "1")).not.toBe(genericApiExternalId("b", "1"));
    expect(genericApiIdentityFromExternalId("a", genericApiExternalId("a", "1"))).toBe("1");
    expect(genericApiIdentityFromExternalId("a", genericApiExternalId("b", "1"))).toBeNull();
  });

  it("round-trips an identity that itself contains the separator", () => {
    const mac = "AA:BB:CC:DD:EE:FF";
    expect(genericApiIdentityFromExternalId("int-1", genericApiExternalId("int-1", mac))).toBe(mac);
  });
});
