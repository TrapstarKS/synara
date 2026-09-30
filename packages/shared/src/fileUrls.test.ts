import { describe, expect, it } from "vitest";

import { encodeFilePathForUrl, markdownFilePathHref, parseFileUrlHref } from "./fileUrls";

describe("filesystem URL destinations", () => {
  it.each([
    [
      String.raw`C:\Users\pedro\.synara\generated_images\call.png`,
      "C:/Users/pedro/.synara/generated_images/call.png",
    ],
    [
      String.raw`\\server\share\.synara\image (100%).png`,
      "//server/share/.synara/image (100%).png",
    ],
    [
      "/Users/José/.synara/image (100%) #? &copy;.png",
      "/Users/José/.synara/image (100%) #? &copy;.png",
    ],
    [String.raw`/Users/me/literal\name%20.png`, String.raw`/Users/me/literal\name%20.png`],
    ["/tmp/[preview] <draft> 'quoted'.png", "/tmp/[preview] <draft> 'quoted'.png"],
  ])("round-trips the literal path %s exactly once", (path, expected) => {
    const encoded = encodeFilePathForUrl(path);
    expect(encoded).not.toMatch(/[\\\s()<>\[\]#?&']/);
    expect(decodeURIComponent(encoded)).toBe(expected);
    expect(parseFileUrlHref(markdownFilePathHref(path))?.path).toBe(expected);
  });

  it("keeps ordinary and relative image destinations unchanged", () => {
    expect(encodeFilePathForUrl("/Users/me/.synara/generated_images/call.png")).toBe(
      "/Users/me/.synara/generated_images/call.png",
    );
    expect(encodeFilePathForUrl("../images/call.png")).toBe("../images/call.png");
  });

  it("retains UNC authority, Windows drives and encoded percent filenames", () => {
    expect(parseFileUrlHref("file://server/share/literal%2520.png")).toEqual({
      path: "//server/share/literal%20.png",
      hash: "",
    });
    expect(parseFileUrlHref("FILE:///C:/Users/me/image%20one.png#L2")).toEqual({
      path: "C:/Users/me/image one.png",
      hash: "#L2",
    });
    expect(parseFileUrlHref("file:///Users/me/literal%2520.png", { decodePath: false })?.path).toBe(
      "/Users/me/literal%2520.png",
    );
    expect(parseFileUrlHref("https://example.com/image.png")).toBeNull();
    expect(parseFileUrlHref("file://[invalid/image.png")).toBeNull();
  });
});
