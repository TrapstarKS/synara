import { describe, expect, it } from "vitest";

import {
  extractAbsoluteFilesystemPaths,
  markdownFilePathHref,
  resolveMarkdownFileLinkTarget,
  resolveUniqueAbsoluteSuffixTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("opens encoded relative text files with spaces and ignores URL query metadata", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "notes/Agent%20handoff.txt?download=1#L12C4",
        "/Users/julius/project",
      ),
    ).toBe("/Users/julius/project/notes/Agent handoff.txt:12:4");
  });

  it("preserves Windows file URL paths with spaces while stripping query metadata", () => {
    expect(resolveMarkdownFileLinkTarget("file:///C:/Work/My%20Project/readme.txt?raw=1#L7")).toBe(
      "C:/Work/My Project/readme.txt:7",
    );
  });

  it.each([
    "/Applications/Synara Beta.app/Contents/Resources/readme.txt",
    "/Library/Application Support/Synara/readme.txt",
    "/System/Library/CoreServices/readme.txt",
  ])("keeps system-folder absolute file links openable: %s", (path) => {
    expect(resolveMarkdownFileLinkTarget(path)).toBe(path);
  });

  it("keeps the v0.9.16 /C:/ normalization for external Windows paths", () => {
    expect(resolveMarkdownFileLinkTarget("/C:/Users/Jane%20Doe/Downloads/report.txt#L3")).toBe(
      "C:/Users/Jane Doe/Downloads/report.txt:3",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});

describe("resolveUniqueAbsoluteSuffixTarget", () => {
  const skillFile = "/Users/tester/.agents/skills/annotate-pr/references/uploadthing.md";
  const tempFile = "/tmp/synara-codex-workspaces/thread-1/notes.md";

  it("keeps line suffixes on the known absolute path", () => {
    expect(resolveUniqueAbsoluteSuffixTarget("notes.md:12", [tempFile])).toBe(`${tempFile}:12`);
  });

  it("returns null when no known path matches", () => {
    expect(resolveUniqueAbsoluteSuffixTarget("references/uploadthing.md", [tempFile])).toBeNull();
  });

  it("returns null when two known paths share the same suffix", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget("references/uploadthing.md", [
        skillFile,
        "/Users/tester/.codex/skills/other/references/uploadthing.md",
      ]),
    ).toBeNull();
  });

  it("does not treat workspace-relative tool paths as known destinations", () => {
    expect(resolveUniqueAbsoluteSuffixTarget("src/index.ts", ["apps/web/src/index.ts"])).toBeNull();
  });

  it("strips a collapsed .../ prefix before matching the real tool path", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget(".../scripts/delete_uploadthing.py", [
        "/Users/tester/.agents/skills/annotate-pr/scripts/delete_uploadthing.py",
      ]),
    ).toBe("/Users/tester/.agents/skills/annotate-pr/scripts/delete_uploadthing.py");
  });

  it("uses a unique basename when the relative path is truncated", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget("delete_uploadthing.py", [
        "/Users/tester/.agents/skills/annotate-pr/scripts/delete_uploadthing.py",
      ]),
    ).toBe("/Users/tester/.agents/skills/annotate-pr/scripts/delete_uploadthing.py");
  });

  it("does not treat a unique known file's parent as a join directory", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget("scripts/upsert_pr_proof.py", [
        "/Users/tester/.agents/skills/annotate-pr/SKILL.md",
      ]),
    ).toBeNull();
  });

  it("returns null when two declared directories would join to different files", () => {
    expect(
      resolveUniqueAbsoluteSuffixTarget("scripts/delete_uploadthing.py", [
        "/Users/tester/.agents/skills/annotate-pr",
        "/Users/tester/.config/opencode/skills/annotate-pr",
      ]),
    ).toBeNull();
  });
});

describe("extractAbsoluteFilesystemPaths", () => {
  it("collects a bare POSIX home path in prose", () => {
    expect(
      extractAbsoluteFilesystemPaths(
        "Created global copy at /Users/tester/.agents/skills/annotate-pr for every project.",
      ),
    ).toEqual(["/Users/tester/.agents/skills/annotate-pr"]);
  });
});

describe("markdownFilePathHref", () => {
  it.each([
    "/vault/space %20 #hash?.md",
    "C:/Users/me/space %20 #hash?.md",
    "//server/share/space %20 #hash?.md",
  ])("round-trips literal path characters in %s", (path) => {
    const href = markdownFilePathHref(path);
    expect(resolveMarkdownFileLinkTarget(href)).toBe(path);
    expect(resolveMarkdownFileLinkTarget(rewriteMarkdownFileUriHref(href)!)).toBe(path);
  });
});
