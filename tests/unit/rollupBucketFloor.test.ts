import { describe, it, expect } from "vitest";
import { bucketFloor } from "../../src/services/sampleRollupService.js";

describe("bucketFloor", () => {
  it("floors to the UTC hour", () => {
    expect(bucketFloor(new Date("2026-11-05T12:40:31.250Z"), "hourly").toISOString()).toBe("2026-11-05T12:00:00.000Z");
  });
  it("floors to the UTC day", () => {
    expect(bucketFloor(new Date("2026-11-03T14:40:00Z"), "daily").toISOString()).toBe("2026-11-03T00:00:00.000Z");
  });
  it("leaves an edge where it is and does not mutate its input", () => {
    const edge = new Date("2026-11-05T12:00:00Z");
    expect(bucketFloor(edge, "hourly").getTime()).toBe(edge.getTime());
    expect(edge.toISOString()).toBe("2026-11-05T12:00:00.000Z");
  });
});
