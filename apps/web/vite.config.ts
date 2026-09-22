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
import { listFiles, pruneProductionIcons } from "./scripts/production-assets";
import { createReactCompilerCache } from "./scripts/reactCompilerCache";

const port = Number(process.env.PORT ?? 5733);
const sourcemapEnv = process.env.SYNARA_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "1" || sourcemapEnv === "true"
    ? true
    : sourcemapEnv === "hidden"
      ? "hidden"
      : false;

// Prune before compression. closeBundle hooks are parallel by default;
// enforce: "post" alone does not make the asynchronous compression hook wait.
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
    closeBundle: {
      order: "pre",
      sequential: true,
      async handler() {
        await pruneProductionIcons(path.join(resolvedRoot, "public"), resolvedOutDir, [
          path.join(resolvedRoot, "src"),
          path.resolve(resolvedRoot, "../../packages/contracts/src"),
          path.resolve(resolvedRoot, "../../packages/shared/src"),
        ]);
        // MSW is used by the dev-served browser tests, never the production app.
        await Promise.all(
          ["", ".gz", ".br"].map((suffix) =>
            fs.rm(path.join(resolvedOutDir, `mockServiceWorker.js${suffix}`), { force: true }),
          ),
        );
      },
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
  plugin.apply = ((_config, { command, mode }) =>
    command === "build" ||
    mode === "test" ||
    /^(1|true)$/i.test(
      process.env.SYNARA_DEV_REACT_COMPILER?.trim() ?? "",
    )) satisfies Plugin["apply"];
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
