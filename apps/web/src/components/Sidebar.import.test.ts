// FILE: Sidebar.import.test.ts
// Purpose: Smoke-test that the large Sidebar module still imports after project-run wiring.
// Layer: Web component module test
// Depends on: Vitest module mocking and Sidebar's transitive imports.

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./terminal/terminalRuntimeRegistry", () => ({
  terminalRuntimeRegistry: {
    disposeTerminal: vi.fn(),
  },
}));

// Warm the component module once: the first dynamic import pays the whole
// Sidebar module-graph transform, which exceeds the per-test budget under a
// full parallel suite on a loaded machine. beforeAll keeps that cost off the
// test's clock; the explicit hook timeout keeps it off the default clock too.
beforeAll(async () => {
  vi.stubGlobal("self", globalThis);
  await import("./Sidebar");
}, 120_000);

describe("Sidebar module", () => {
  it("loads after project-run wiring", async () => {
    vi.stubGlobal("self", globalThis);
    const module = await import("./Sidebar");

    expect(module.default).toBeTypeOf("function");
    // Full-suite runs transform many web files concurrently; this import can cross Vitest's 5s default.
  }, 15_000);
});
