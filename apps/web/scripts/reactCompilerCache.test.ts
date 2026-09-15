import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createReactCompilerCache } from "./reactCompilerCache";

let directory: string;
let config: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "synara-compiler-cache-"));
  config = join(directory, "config.ts");
  await writeFile(config, "compiler options v1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const cache = () => createReactCompilerCache("test", [config], join(directory, "cache"));

it("reuses exact transforms and source maps, invalidating source, path, mode and config changes", async () => {
  const compile = vi.fn(() => ({
    code: "compiled",
    map: { sources: ["a.tsx"], mappings: "AAAA" },
  }));
  const run = cache();
  const result = await run("a.tsx", "source", "production", compile);
  expect(await cache()("a.tsx", "source", "production", compile)).toEqual(result);
  expect(compile).toHaveBeenCalledTimes(1);
  await run("a.tsx", "edited", "production", compile);
  await run("b.tsx", "edited", "production", compile);
  await run("b.tsx", "edited", "ssr", compile);
  await writeFile(config, "compiler options v2");
  await cache()("b.tsx", "edited", "ssr", compile);
  expect(compile).toHaveBeenCalledTimes(5);
});

it("rebuilds corrupt entries and never caches compiler failures", async () => {
  const run = cache();
  const compile = vi.fn(() => "compiled");
  await run("a", "source", null, compile);
  const root = join(directory, "cache");
  const [entry] = (await readdir(root, { recursive: true })).filter((file) =>
    file.endsWith(".json"),
  );
  expect(entry).toBeTruthy();
  await writeFile(join(root, entry!), "truncated JSON");
  expect(await run("a", "source", null, compile)).toBe("compiled");
  expect(compile).toHaveBeenCalledTimes(2);
  const failure = () => {
    throw new Error("compiler failed");
  };
  await expect(run("a", "changed", null, failure)).rejects.toThrow("compiler failed");
  expect(await run("a", "changed", null, compile)).toBe("compiled");
  expect(compile).toHaveBeenCalledTimes(3);
});

it("allows explicit fresh compilation and works when the cache cannot be written", async () => {
  const compile = vi.fn(() => "compiled");
  const run = cache();
  await run("a", "source", null, compile);
  vi.stubEnv("SYNARA_COMPILER_CACHE", "0");
  await run("a", "source", null, compile);
  expect(compile).toHaveBeenCalledTimes(2);
  vi.unstubAllEnvs();
  const blocked = createReactCompilerCache("test", [config], config);
  expect(await blocked("a", "source", null, compile)).toBe("compiled");
  expect(await readFile(config, "utf8")).toBe("compiler options v1");
});
