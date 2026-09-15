import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// Cache only file-local compiler work. Each module has one slot per compiler
// configuration; editing it replaces the slot instead of retaining every edit.
export function createReactCompilerCache(
  namespace: string,
  configFiles: ReadonlyArray<string | URL>,
  cacheRoot = fileURLToPath(new URL("../node_modules/.cache/react-compiler", import.meta.url)),
) {
  const fingerprint = createHash("sha256");
  fingerprint.update(
    JSON.stringify([
      namespace,
      process.version,
      process.platform,
      process.arch,
      process.env.NODE_ENV,
      process.env.BABEL_ENV,
    ]),
  );
  for (const file of [
    new URL("../../../bun.lock", import.meta.url),
    new URL(import.meta.url),
    ...configFiles,
    ...[
      "@babel/core",
      "babel-plugin-react-compiler",
      "@rolldown/plugin-babel",
      "@vitejs/plugin-react",
    ].map((name) => require.resolve(name)),
  ]) {
    fingerprint.update(readFileSync(file));
  }
  const directory = join(cacheRoot, fingerprint.digest("hex"));

  return async function cached<T>(
    id: string,
    source: string,
    context: unknown,
    compile: () => T | Promise<T>,
  ): Promise<T> {
    if (process.env.SYNARA_COMPILER_CACHE === "0") return compile();
    const key = digest(JSON.stringify([source, context]));
    const file = join(directory, `${digest(id)}.json`);
    try {
      const entry = JSON.parse(await readFile(file, "utf8"));
      if (entry?.key === key && Object.hasOwn(entry, "value")) return entry.value as T;
    } catch {
      // Missing or damaged cache entries are rebuilt from source.
    }

    const value = await compile(); // Compiler errors must propagate and never be cached.
    if (value !== undefined) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, JSON.stringify({ key, value }));
        await rename(temporary, file);
      } catch {
        // A read-only/full cache must not break a valid build.
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    }
    return value;
  };
}
