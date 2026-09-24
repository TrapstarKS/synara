import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_OVERLAY_ROLLOUT_RETENTION_MS,
  pruneCodexOverlayRollouts,
} from "./codexOverlayRolloutRetention.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const id = (n: number) => `01a09c5e-7435-7253-9234-${String(n).padStart(12, "0")}`;

describe("pruneCodexOverlayRollouts", () => {
  it("deletes only idle rollouts no active thread can resume", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "overlay-rollouts-"));
    roots.push(root);
    const day = path.join(root, "profile", "sessions", "2026", "09", "01");
    await fs.mkdir(day, { recursive: true });
    const nowMs = Date.parse("2026-09-24T00:00:00Z");
    const old = new Date(nowMs - CODEX_OVERLAY_ROLLOUT_RETENTION_MS - 60_000);
    const write = async (n: number, meta: object, mtime = old) => {
      const file = path.join(day, `rollout-2026-09-01T00-00-00-${id(n)}.jsonl`);
      await fs.writeFile(file, `${JSON.stringify({ type: "session_meta", payload: meta })}\nx\n`);
      await fs.utimes(file, mtime, mtime);
      return file;
    };
    const active = await write(1, { source: "vscode" });
    const orphan = await write(2, { source: "vscode" });
    const childOfActive = await write(3, {
      source: { subagent: { thread_spawn: { parent_thread_id: id(1) } } },
    });
    const childOfOrphan = await write(4, {
      source: { subagent: { thread_spawn: { parent_thread_id: id(2) } } },
    });
    const recentOrphan = await write(5, { source: "vscode" }, new Date(nowMs - 60_000));
    // The default overlay links the user's own ~/.codex/sessions: never entered.
    const userSessions = path.join(root, "user-codex-sessions");
    await fs.mkdir(userSessions);
    const userRollout = path.join(userSessions, `rollout-2026-09-01T00-00-00-${id(6)}.jsonl`);
    await fs.writeFile(userRollout, "{}\n");
    await fs.utimes(userRollout, old, old);
    await fs.mkdir(path.join(root, "linked"));
    await fs.symlink(userSessions, path.join(root, "linked", "sessions"));

    const result = await pruneCodexOverlayRollouts({
      overlaysRoot: root,
      activeCodexThreadIds: new Set([id(1)]),
      nowMs,
    });

    const exists = (file: string) =>
      fs.stat(file).then(
        () => true,
        () => false,
      );
    expect(result.deletedFiles).toBe(2);
    expect(await exists(active)).toBe(true);
    expect(await exists(childOfActive)).toBe(true);
    expect(await exists(recentOrphan)).toBe(true);
    expect(await exists(userRollout)).toBe(true);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(childOfOrphan)).toBe(false);
  });
});
