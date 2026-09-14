// FILE: applyPatch.test.ts
// Purpose: Unit tests for the connector's V4A apply_patch tool: parsing,
//          preflight atomicity, path safety and line-ending handling.
// Layer: Server provider connector / tools

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceToolContext } from "../types.ts";
import { runApplyPatchTool, type ApplyPatchOutcome } from "./applyPatch.ts";

const createdRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "synara-apply-patch-"));
  createdRoots.push(root);
  return root;
}

afterEach(async () => {
  const roots = createdRoots.splice(0, createdRoots.length);
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

function run(root: string, patch: string): Promise<ApplyPatchOutcome> {
  const ctx: WorkspaceToolContext = { workspaceRoot: root };
  return runApplyPatchTool(ctx, { patch });
}

function patchText(lines: readonly string[]): string {
  return lines.join("\n");
}

function expectSuccess(outcome: ApplyPatchOutcome): readonly string[] {
  if (!outcome.ok) throw new Error(`expected patch to succeed, but it failed: ${outcome.error}`);
  return outcome.summary;
}

function expectFailure(outcome: ApplyPatchOutcome): string {
  if (outcome.ok)
    throw new Error(`expected patch to fail, but it succeeded: ${outcome.summary.join(", ")}`);
  return outcome.error;
}

async function writeWorkspaceFile(
  root: string,
  relative: string,
  contents: string | Buffer,
): Promise<string> {
  const absolute = nodePath.join(root, relative);
  await fs.mkdir(nodePath.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents);
  return absolute;
}

describe("runApplyPatchTool", () => {
  it("adds a nested file and creates parent directories", async () => {
    const root = await makeWorkspace();
    const outcome = await run(
      root,
      patchText([
        "*** Begin Patch",
        "*** Add File: nested/dir/hello.txt",
        "+hello",
        "+world",
        "*** End Patch",
      ]),
    );

    expect(expectSuccess(outcome)).toEqual(["A nested/dir/hello.txt"]);
    await expect(fs.readFile(nodePath.join(root, "nested/dir/hello.txt"), "utf8")).resolves.toBe(
      "hello\nworld\n",
    );
  });

  it("applies add, update and delete operations in order against in-memory state", async () => {
    const root = await makeWorkspace();
    await writeWorkspaceFile(root, "b.txt", "remove me\n");

    const outcome = await run(
      root,
      patchText([
        "*** Begin Patch",
        "*** Add File: a.txt",
        "+one",
        "+two",
        "*** Update File: a.txt",
        "@@",
        "-one",
        "+ONE",
        " two",
        "*** Delete File: b.txt",
        "*** End Patch",
      ]),
    );

    expect(expectSuccess(outcome)).toEqual(["A a.txt", "M a.txt", "D b.txt"]);
    await expect(fs.readFile(nodePath.join(root, "a.txt"), "utf8")).resolves.toBe("ONE\ntwo\n");
    await expect(fs.access(nodePath.join(root, "b.txt"))).rejects.toThrow();
  });

  it("updates a file with a single hunk", async () => {
    const root = await makeWorkspace();
    const file = await writeWorkspaceFile(root, "file.txt", "one\ntwo\nthree\n");

    const outcome = await run(
      root,
      patchText([
        "*** Begin Patch",
        "*** Update File: file.txt",
        "@@",
        " one",
        "-two",
        "+TWO",
        " three",
        "*** End Patch",
      ]),
    );

    expect(expectSuccess(outcome)).toEqual(["M file.txt"]);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("one\nTWO\nthree\n");
  });

  it("applies two hunks where the second searches after the first", async () => {
    const root = await makeWorkspace();
    const file = await writeWorkspaceFile(root, "order.txt", "x\ny\nx\ny\n");

    const outcome = await run(
      root,
      patchText([
        "*** Begin Patch",
        "*** Update File: order.txt",
        "@@",
        " x",
        " y",
        "+z",
        "@@",
        " x",
        " y",
        "+w",
        "*** End Patch",
      ]),
    );

    expect(expectSuccess(outcome)).toEqual(["M order.txt"]);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("x\ny\nz\nx\ny\nw\n");
  });

  it("moves and updates a file", async () => {
    const root = await makeWorkspace();
    await writeWorkspaceFile(root, "old/name.txt", "hello\nworld\n");

    const outcome = await run(
      root,
      patchText([
        "*** Begin Patch",
        "*** Update File: old/name.txt",
        "*** Move to: new/name.txt",
        "@@",
        "-hello",
        "+HELLO",
        " world",
        "*** End Patch",
      ]),
    );

    expect(expectSuccess(outcome)).toEqual(["M old/name.txt -> new/name.txt"]);
    await expect(fs.readFile(nodePath.join(root, "new/name.txt"), "utf8")).resolves.toBe(
      "HELLO\nworld\n",
    );
    await expect(fs.access(nodePath.join(root, "old/name.txt"))).rejects.toThrow();
  });

  it("deletes a file", async () => {
    const root = await makeWorkspace();
    await writeWorkspaceFile(root, "gone.txt", "bye\n");

    const outcome = await run(
      root,
      patchText(["*** Begin Patch", "*** Delete File: gone.txt", "*** End Patch"]),
    );

    expect(expectSuccess(outcome)).toEqual(["D gone.txt"]);
    await expect(fs.access(nodePath.join(root, "gone.txt"))).rejects.toThrow();
  });

  it("preserves CRLF line endings when updating a CRLF file", async () => {
    const root = await makeWorkspace();
    const absolute = await writeWorkspaceFile(
      root,
      "crlf.txt",
      Buffer.from("alpha\r\nbeta\r\ngamma\r\n", "utf8"),
    );

    const outcome = await run(
      root,
      patchText([
        "*** Begin Patch",
        "*** Update File: crlf.txt",
        "@@",
        " alpha",
        "-beta",
        "+BETA",
        " gamma",
        "*** End Patch",
      ]),
    );

    expect(expectSuccess(outcome)).toEqual(["M crlf.txt"]);
    await expect(fs.readFile(absolute, "utf8")).resolves.toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  it("anchors hunks marked with *** End of File to the end of the file", async () => {
    const root = await makeWorkspace();
    const file = await writeWorkspaceFile(root, "eof.txt", "alpha\nbeta\n");

    const outcome = await run(
      root,
      patchText([
        "*** Begin Patch",
        "*** Update File: eof.txt",
        "@@",
        "-beta",
        "+gamma",
        "*** End of File",
        "*** End Patch",
      ]),
    );

    expect(expectSuccess(outcome)).toEqual(["M eof.txt"]);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("alpha\ngamma\n");
  });

  it("refuses a malformed envelope and names the offending line", async () => {
    const root = await makeWorkspace();
    const outcome = await run(root, "this is not a patch");

    const error = expectFailure(outcome);
    expect(error).toContain("*** Begin Patch");
    expect(error).toContain("line 1");
  });

  it("refuses a patch that is missing the end marker", async () => {
    const root = await makeWorkspace();
    const outcome = await run(root, patchText(["*** Begin Patch", "*** Add File: a.txt", "+x"]));

    expect(expectFailure(outcome)).toContain("*** End Patch");
  });

  it("leaves the file byte-identical when a hunk does not match", async () => {
    const root = await makeWorkspace();
    const file = await writeWorkspaceFile(root, "file.txt", "keep\nthis\nstable\n");
    const before = await fs.readFile(file);

    const outcome = await run(
      root,
      patchText([
        "*** Begin Patch",
        "*** Update File: file.txt",
        "@@",
        " keep",
        "-that",
        "+changed",
        "*** End Patch",
      ]),
    );

    expect(expectFailure(outcome)).toBe("Failed to find hunk 1 in file.txt");
    const after = await fs.readFile(file);
    expect(after.equals(before)).toBe(true);
  });

  it("preflights every hunk before writing anything", async () => {
    const root = await makeWorkspace();
    const file = await writeWorkspaceFile(root, "file.txt", "one\ntwo\n");
    const before = await fs.readFile(file);

    const outcome = await run(
      root,
      patchText([
        "*** Begin Patch",
        "*** Update File: file.txt",
        "@@",
        "-one",
        "+ONE",
        "@@",
        "-missing",
        "+MISSING",
        "*** End Patch",
      ]),
    );

    expect(expectFailure(outcome)).toBe("Failed to find hunk 2 in file.txt");
    const after = await fs.readFile(file);
    expect(after.equals(before)).toBe(true);
  });

  it("refuses paths that escape the workspace root", async () => {
    const root = await makeWorkspace();
    const outsideName = `escape-${nodePath.basename(root)}.txt`;

    const outcome = await run(
      root,
      patchText(["*** Begin Patch", `*** Add File: ../${outsideName}`, "+x", "*** End Patch"]),
    );

    expect(expectFailure(outcome)).toContain("escapes the workspace root");
    await expect(fs.access(nodePath.join(root, "..", outsideName))).rejects.toThrow();
  });

  it("refuses absolute paths", async () => {
    const root = await makeWorkspace();
    const outcome = await run(
      root,
      patchText([
        "*** Begin Patch",
        "*** Add File: /tmp/synara-apply-patch-absolute.txt",
        "+x",
        "*** End Patch",
      ]),
    );

    expect(expectFailure(outcome)).toContain("Absolute paths are not allowed");
  });

  it("refuses to patch files containing NUL bytes", async () => {
    const root = await makeWorkspace();
    const file = await writeWorkspaceFile(
      root,
      "binary.bin",
      Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6c, 0x6f]),
    );
    const before = await fs.readFile(file);

    const outcome = await run(
      root,
      patchText([
        "*** Begin Patch",
        "*** Update File: binary.bin",
        "@@",
        "-hello",
        "+HELLO",
        "*** End Patch",
      ]),
    );

    expect(expectFailure(outcome)).toContain("NUL");
    const after = await fs.readFile(file);
    expect(after.equals(before)).toBe(true);
  });

  it("refuses patches larger than 1 MiB", async () => {
    const root = await makeWorkspace();
    const body = "+x\n".repeat(400_000);
    const oversized = `*** Begin Patch\n*** Add File: huge.txt\n${body}*** End Patch`;
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(1024 * 1024);

    expect(expectFailure(await run(root, oversized))).toMatch(/too large/i);
    await expect(fs.access(nodePath.join(root, "huge.txt"))).rejects.toThrow();
  });

  it("refuses patches with more than 50 operations", async () => {
    const root = await makeWorkspace();
    const lines = ["*** Begin Patch"];
    for (let index = 0; index < 51; index += 1) {
      lines.push(`*** Add File: file-${index}.txt`, "+x");
    }
    lines.push("*** End Patch");

    expect(expectFailure(await run(root, patchText(lines)))).toContain("too many files");
    await expect(fs.access(nodePath.join(root, "file-0.txt"))).rejects.toThrow();
  });

  it("refuses an add for a file that already exists", async () => {
    const root = await makeWorkspace();
    const file = await writeWorkspaceFile(root, "existing.txt", "keep\n");

    const outcome = await run(
      root,
      patchText(["*** Begin Patch", "*** Add File: existing.txt", "+new", "*** End Patch"]),
    );

    expect(expectFailure(outcome)).toContain("already exists");
    await expect(fs.readFile(file, "utf8")).resolves.toBe("keep\n");
  });

  it("refuses an update with no hunks and no move destination", async () => {
    const root = await makeWorkspace();
    const outcome = await run(
      root,
      patchText(["*** Begin Patch", "*** Update File: file.txt", "*** End Patch"]),
    );

    expect(expectFailure(outcome)).toContain("at least one hunk");
  });

  it("rejects the Environment ID directive", async () => {
    const root = await makeWorkspace();
    const outcome = await run(
      root,
      patchText(["*** Begin Patch", "*** Environment ID: env-1", "*** End Patch"]),
    );

    expect(expectFailure(outcome)).toContain("environment ids are not accepted");
  });

  it("rejects unknown directives", async () => {
    const root = await makeWorkspace();
    const outcome = await run(
      root,
      patchText(["*** Begin Patch", "*** Frobnicate: file.txt", "*** End Patch"]),
    );

    expect(expectFailure(outcome)).toContain("Unknown patch directive");
  });
});
