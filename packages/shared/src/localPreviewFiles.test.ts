import { describe, expect, it } from "vitest";

import { lowerCaseExtensionOf } from "./localPreviewFiles";

describe("lowerCaseExtensionOf", () => {
  it.each([
    ["Artifacts/archive", null],
    ["build.v2/archive", null],
    ["build.v2/archive.ZIP", ".zip"],
    ["C:\\Build.v2\\archive", null],
    ["C:\\Build.v2\\archive.PDF", ".pdf"],
    [".env", null],
  ])("reads only the filename extension from %s", (filePath, expected) => {
    expect(lowerCaseExtensionOf(filePath)).toBe(expected);
  });
});
