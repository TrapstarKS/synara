// FILE: read.test.ts
// Purpose: Unit tests for the ChatGPT connector `read` tool and its workspace path helper.
// Layer: Server provider connector tests

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { McpToolCallResult, WorkspaceToolContext } from "../types.ts";
import { resolveWithinRoot, runReadTool, WorkspacePathError } from "./read.ts";

const temporaryRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "synara-read-tool-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function toolContext(workspaceRoot: string): WorkspaceToolContext {
  return { workspaceRoot };
}

function textOf(result: McpToolCallResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("resolveWithinRoot", () => {
  it("resolves relative paths and normalizes inside the root", async () => {
    const root = await tempRoot();
    expect(resolveWithinRoot(root, "notes/hello.txt").absolutePath).toBe(
      path.join(root, "notes", "hello.txt"),
    );
    expect(resolveWithinRoot(root, "./notes/../hello.txt").relativePath).toBe("hello.txt");
    expect(resolveWithinRoot(root, ".").relativePath).toBe(".");
  });

  it("accepts an absolute path only when it is inside the root", async () => {
    const root = await tempRoot();
    const inside = path.join(root, "inside.txt");
    expect(resolveWithinRoot(root, inside)).toEqual({
      absolutePath: inside,
      relativePath: "inside.txt",
    });
  });

  it("rejects relative escapes and absolute paths outside the root", async () => {
    const root = await tempRoot();
    expect(() => resolveWithinRoot(root, "../escape.txt")).toThrow(WorkspacePathError);
    expect(() => resolveWithinRoot(root, path.join(root, "..", "escape.txt"))).toThrow(
      WorkspacePathError,
    );
    expect(() => resolveWithinRoot(root, "")).toThrow(WorkspacePathError);
  });
});

describe("runReadTool", () => {
  it("reads a file and labels it with the workspace-relative path", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "notes", "hello.txt"), "hello\nworld\n");

    const result = await runReadTool(toolContext(root), { paths: ["notes/hello.txt"] });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe("--- notes/hello.txt ---\nhello\nworld");
  });

  it("applies start_line/end_line before size truncation", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "lines.txt"), "one\ntwo\nthree\nfour\n");

    const result = await runReadTool(toolContext(root), {
      paths: ["lines.txt"],
      start_line: 2,
      end_line: 3,
    });

    expect(textOf(result)).toBe("--- lines.txt ---\ntwo\nthree");
  });

  it("reports a range past the end of a file without inventing content", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "lines.txt"), "one\ntwo\n");

    const result = await runReadTool(toolContext(root), {
      paths: ["lines.txt"],
      start_line: 10,
      end_line: 12,
    });

    expect(textOf(result)).toBe("--- lines.txt ---\n(no lines in that range)");
  });

  it("lists a directory one level deep, directories first and suffixed", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "folder", "sub"), { recursive: true });
    await writeFile(path.join(root, "folder", "b.txt"), "b");
    await writeFile(path.join(root, "folder", "a.txt"), "a");

    const result = await runReadTool(toolContext(root), { paths: ["folder"] });

    expect(textOf(result)).toBe("--- folder ---\nsub/\na.txt\nb.txt");
  });

  it("reports a missing path as an error section", async () => {
    const root = await tempRoot();

    const result = await runReadTool(toolContext(root), { paths: ["missing.txt"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("--- missing.txt ---\nError: not found");
  });

  it("reports binary files by size instead of dumping bytes", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "blob.bin"), Buffer.from("abc\u0000def"));

    const result = await runReadTool(toolContext(root), { paths: ["blob.bin"] });

    expect(textOf(result)).toBe("--- blob.bin ---\n(binary file, 7 bytes)");
  });

  it("rejects escapes without reading the outside file", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(path.join(outside, "secret.txt"), "SECRET-CONTENT");
    const outsideAbsolute = path.join(outside, "secret.txt");

    const absoluteResult = await runReadTool(toolContext(root), { paths: [outsideAbsolute] });
    const relativeResult = await runReadTool(toolContext(root), {
      paths: [path.posix.join("..", path.basename(outside), "secret.txt")],
    });

    expect(absoluteResult.isError).toBe(true);
    expect(relativeResult.isError).toBe(true);
    expect(textOf(absoluteResult)).toContain("outside the workspace root");
    expect(textOf(relativeResult)).toContain("outside the workspace root");
    expect(textOf(absoluteResult)).not.toContain("SECRET-CONTENT");
    expect(textOf(relativeResult)).not.toContain("SECRET-CONTENT");
  });

  it("expands a final-segment wildcard and caps the match list", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "src"));
    for (let index = 0; index < 25; index += 1) {
      const name = `file-${String(index).padStart(2, "0")}.txt`;
      await writeFile(path.join(root, "src", name), `content ${index}`);
    }

    const result = await runReadTool(toolContext(root), { paths: ["src/*.txt"] });
    const text = textOf(result);

    expect(text.match(/^--- /gm)).toHaveLength(20);
    expect(text).toContain("more than 20 matches");
    expect(text).toContain("--- src/file-00.txt ---");
    expect(text).not.toContain("--- src/file-24.txt ---");
  });

  it("expands a trailing /** recursively", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await writeFile(path.join(root, "src", "top.ts"), "top");
    await writeFile(path.join(root, "src", "nested", "deep.ts"), "deep");

    const result = await runReadTool(toolContext(root), { paths: ["src/**"] });
    const text = textOf(result);

    expect(text).toContain("--- src/top.ts ---");
    expect(text).toContain("--- src/nested/deep.ts ---");
  });

  it("keeps the aggregate payload under the call budget with a truncation note", async () => {
    const root = await tempRoot();
    const content = "a".repeat(200 * 1024);
    await writeFile(path.join(root, "a.txt"), content);
    await writeFile(path.join(root, "b.txt"), "b".repeat(200 * 1024));
    await writeFile(path.join(root, "c.txt"), "c".repeat(200 * 1024));

    const result = await runReadTool(toolContext(root), { paths: ["a.txt", "b.txt", "c.txt"] });
    const text = textOf(result);

    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(530 * 1024);
    expect(text).toContain("--- a.txt ---");
    expect(text).toContain("--- c.txt ---");
    expect(text).toContain("truncated");
  });

  it("honors max_bytes per file", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "big.txt"), "0123456789".repeat(100));

    const result = await runReadTool(toolContext(root), { paths: ["big.txt"], max_bytes: 10 });
    const text = textOf(result);

    expect(text).toContain("--- big.txt ---\n0123456789");
    expect(text).toContain("truncated");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(200);
  });

  it("returns a clear error section for garbage line arguments", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "a.txt"), "a\n");

    const startResult = await runReadTool(toolContext(root), {
      paths: ["a.txt"],
      start_line: "nope" as unknown as number,
    });
    const endResult = await runReadTool(toolContext(root), {
      paths: ["a.txt"],
      start_line: 5,
      end_line: 2,
    });

    expect(startResult.isError).toBe(true);
    expect(textOf(startResult)).toContain("start_line must be a positive integer");
    expect(endResult.isError).toBe(true);
    expect(textOf(endResult)).toContain("end_line must be greater than or equal to start_line");
  });

  it("rejects an empty path list", async () => {
    const root = await tempRoot();
    const result = await runReadTool(toolContext(root), { paths: [] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("paths must be a non-empty array");
  });
});
