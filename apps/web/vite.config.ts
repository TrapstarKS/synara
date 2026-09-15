// FILE: vite.config.ts
// Purpose: Builds the Synara web client and controls diagnostic source maps.
// Layer: Web build config
// Depends on: Vite, Tailwind, React compiler, TanStack Router.

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };
import { createReactCompilerCache } from "./scripts/reactCompilerCache";

const port = Number(process.env.PORT ?? 5733);
const sourcemapEnv = process.env.SYNARA_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "1" || sourcemapEnv === "true"
    ? true
    : sourcemapEnv === "hidden"
      ? "hidden"
      : false;

const CENTRAL_ICON_DIR = "central-icons-reversed";
const CENTRAL_ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const result: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      result.push(entryPath);
    }
  }
  return result;
}

// Finds literal icon basenames in source, then prunes the copied public icon set after build.
function centralIconPrunePlugin(): Plugin {
  let resolvedRoot = process.cwd();
  let resolvedOutDir = "dist";
  return {
    name: "synara-central-icon-prune",
    apply: "build",
    configResolved(config) {
      resolvedRoot = config.root;
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const publicIconDir = path.join(resolvedRoot, "public", CENTRAL_ICON_DIR);
      const distIconDir = path.join(resolvedOutDir, CENTRAL_ICON_DIR);
      const iconFiles = await fs.readdir(publicIconDir).catch(() => []);
      const availableIcons = new Set(
        iconFiles
          .filter((name) => name.endsWith(".svg"))
          .map((name) => name.slice(0, -".svg".length)),
      );
      if (availableIcons.size === 0) return;

      const sourceFiles = (await listFiles(path.join(resolvedRoot, "src"))).filter((file) =>
        SOURCE_EXTENSIONS.has(path.extname(file)),
      );
      const requiredIcons = new Set<string>();
      const literalPattern = /["'`]([a-z0-9][a-z0-9-]*)["'`]/g;
      for (const sourceFile of sourceFiles) {
        const source = await fs.readFile(sourceFile, "utf8").catch(() => "");
        for (const match of source.matchAll(literalPattern)) {
          const iconName = match[1];
          if (
            iconName &&
            CENTRAL_ICON_NAME_PATTERN.test(iconName) &&
            availableIcons.has(iconName)
          ) {
            requiredIcons.add(iconName);
          }
        }
      }

      if (requiredIcons.size === 0) return;
      const copiedIconFiles = await fs.readdir(distIconDir).catch(() => []);
      let removedCount = 0;
      await Promise.all(
        copiedIconFiles.map(async (fileName) => {
          if (!fileName.endsWith(".svg")) return;
          const iconName = fileName.slice(0, -".svg".length);
          if (requiredIcons.has(iconName)) return;
          removedCount += 1;
          await fs.rm(path.join(distIconDir, fileName), { force: true });
        }),
      );
      console.info(
        `[central-icons] kept ${requiredIcons.size}/${availableIcons.size} referenced SVGs, pruned ${removedCount}.`,
      );
    },
  };
}

const gzip = promisify(zlib.gzip);
const brotliCompress = promisify(zlib.brotliCompress);

const PRECOMPRESS_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".map"]);
// Below this size, compression savings don't beat the extra header bytes and
// the sidecar file overhead.
const PRECOMPRESS_MIN_BYTES = 1024;

// Emits .gz and .br sidecars next to compressible build outputs so the server
// can serve precompressed bytes by Accept-Encoding instead of compressing on
// the request path (apps/server/src/http.ts static route).
function precompressPlugin(): Plugin {
  let resolvedOutDir = "dist";
  return {
    name: "synara-precompress",
    apply: "build",
    // Run after central-icon pruning so removed files don't get sidecars.
    enforce: "post",
    configResolved(config) {
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files = (await listFiles(resolvedOutDir)).filter((file) =>
        PRECOMPRESS_EXTENSIONS.has(path.extname(file)),
      );
      // A sidecar whose source shrank below threshold or stopped compressing
      // smaller must be removed, not just skipped: emptyOutDir protects full
      // builds, but partial/watch builds would otherwise serve a stale
      // compressed body under a current filename.
      const removeStale = (sidecarPath: string) => fs.rm(sidecarPath, { force: true });
      // Write to a temp file and rename: a watch-build server reading a
      // sidecar mid-write would otherwise get a truncated compressed stream.
      // Rename is atomic within a directory, so readers see either the old
      // sidecar or the complete new one.
      let tempSequence = 0;
      const writeSidecarAtomically = async (sidecarPath: string, data: Buffer) => {
        // Unique per write so concurrent builds against one outDir cannot
        // clobber each other's staging file.
        tempSequence += 1;
        const tempPath = `${sidecarPath}.${process.pid}.${tempSequence}.tmp`;
        await fs.writeFile(tempPath, data);
        await fs.rename(tempPath, sidecarPath);
      };
      let sidecarCount = 0;
      await Promise.all(
        files.map(async (file) => {
          const source = await fs.readFile(file);
          if (source.byteLength < PRECOMPRESS_MIN_BYTES) {
            await Promise.all([removeStale(`${file}.gz`), removeStale(`${file}.br`)]);
            return;
          }
          // Level 5 keeps precompressed responses without spending seconds on
          // maximum-quality compression for every build (including test builds).
          const brotliQuality = 5;
          const [gzipped, brotlied] = await Promise.all([
            gzip(source, { level: zlib.constants.Z_BEST_COMPRESSION }),
            brotliCompress(source, {
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
              },
            }),
          ]);
          await Promise.all([
            gzipped.byteLength < source.byteLength
              ? writeSidecarAtomically(`${file}.gz`, gzipped)
              : removeStale(`${file}.gz`),
            brotlied.byteLength < source.byteLength
              ? writeSidecarAtomically(`${file}.br`, brotlied)
              : removeStale(`${file}.br`),
          ]);
          sidecarCount += 1;
        }),
      );
      console.info(`[precompress] emitted gzip+brotli sidecars for ${sidecarCount} files.`);
    },
  };
}

async function cachedReactCompilerPlugin(): Promise<Plugin> {
  const plugin = (await babel({
    // Workspace packages are outside the app's CWD, so select their parsers
    // explicitly instead of relying on Babel's relative-path defaults.
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [reactCompilerPreset()],
  })) as Plugin;
  const transform = plugin.transform;
  // Keep working if a future Babel plugin changes its hook representation.
  if (!transform || typeof transform === "function") return plugin;

  const cached = createReactCompilerCache("build", [new URL(import.meta.url)]);
  const originalTransform = transform.handler;
  // Mutate the existing hook: Babel's config hooks update its filter in place.
  // Its transform is file-local and emits no files or watch dependencies.
  transform.handler = function (code, id, options) {
    const environment = this.environment;
    const compile = () => originalTransform.call(this, code, id, options);
    if (
      environment?.config.command !== "build" ||
      this.meta.watchMode ||
      environment.config.consumer !== "client" ||
      id.startsWith("\0")
    ) {
      return compile();
    }
    return cached(
      id,
      code,
      [environment.config.mode, environment.name, environment.config.build.sourcemap, options],
      compile,
    );
  };
  return plugin;
}

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    cachedReactCompilerPlugin(),
    tailwindcss(),
    centralIconPrunePlugin(),
    precompressPlugin(),
  ],
  optimizeDeps: {
    include: [
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@pierre/diffs/worker/worker.js",
      "react-icons/gr",
    ],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port,
    strictPort: true,
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
    // Sidecars already compress the outputs; a second gzip pass just for the
    // console's size report adds work without changing any shipped bytes.
    reportCompressedSize: false,
    // The largest chunks are intentionally lazy-loaded editor grammars,
    // terminal runtime code, and the chat route—not initial-load bundles.
    chunkSizeWarningLimit: 850,
    rolldownOptions: {
      checks: {
        // React Compiler is expected to dominate transform time in this app.
        pluginTimings: false,
      },
    },
  },
});
