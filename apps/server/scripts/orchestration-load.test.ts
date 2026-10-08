import { describe, expect, it } from "vitest";
import { loadOptions, peakOverlap, summarize } from "./orchestration-load";

describe("orchestration load fixture", () => {
  it("uses bounded, configurable workload parameters", () => {
    expect(loadOptions(["--threads", "1", "--rate", "40", "--seconds", "2"]).ticks).toBe(80);
    expect(loadOptions([]).threads).toBe(20);
    for (const args of [
      ["--threads", "0"],
      ["--threads", "65"],
      ["--rate", "NaN"],
      ["--seconds", "0"],
    ]) {
      expect(() => loadOptions(args)).toThrow();
    }
  });

  it("computes percentiles without mutating observations", () => {
    const input = [10, 1, 5, 2];
    expect(summarize(input)).toEqual({ count: 4, p50: 5, p95: 10, p99: 10, max: 10 });
    expect(input).toEqual([10, 1, 5, 2]);
    expect(summarize([]).count).toBe(0);
  });

  it("measures real overlap and treats touching intervals as sequential", () => {
    expect(
      peakOverlap([
        { started: 0, ended: 10 },
        { started: 10, ended: 20 },
      ]),
    ).toBe(1);
    expect(
      peakOverlap([
        { started: 0, ended: 10 },
        { started: 5, ended: 20 },
      ]),
    ).toBe(2);
    expect(peakOverlap([])).toBe(0);
  });
});
