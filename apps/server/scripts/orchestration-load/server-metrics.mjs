import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { plugin } from "bun";

if (process.env.SYNARA_LOAD_BASELINE) {
  const sources = JSON.parse(readFileSync(process.env.SYNARA_LOAD_BASELINE, "utf8"));
  plugin({
    name: "load-fixture-baseline",
    setup(build) {
      for (const [path, contents] of Object.entries(sources)) {
        build.onLoad(
          { filter: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) },
          () => ({ contents, loader: path.endsWith("tsx") ? "tsx" : "ts" }),
        );
      }
    },
  });
}

const target = process.env.SYNARA_LOAD_METRICS;
if (!target) throw new Error("The load metrics preload requires an isolated output path.");
const samples = [];
const phaseSamples = { startup: [], streaming: [] };
let previous = performance.now();
let peakRss = 0;
let initialRss = 0;
let active = false;
setInterval(() => {
  const now = performance.now();
  if (existsSync(`${target}.active`)) {
    if (!active) {
      samples.length = 0;
      initialRss = process.memoryUsage().rss;
      peakRss = initialRss;
      active = true;
    } else {
      const lag = Math.max(0, now - previous - 10);
      samples.push(lag);
      phaseSamples[existsSync(`${target}.streaming`) ? "streaming" : "startup"].push(lag);
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  previous = now;
}, 10).unref();
setInterval(() => {
  if (!active) return;
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  writeFileSync(
    target,
    JSON.stringify({
      sampleCount: samples.length,
      lagMs: {
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        max: sorted.at(-1) ?? 0,
      },
      rssBytes: { initial: initialRss, peak: peakRss, final: process.memoryUsage().rss },
      phaseLagMs: Object.fromEntries(
        Object.entries(phaseSamples).map(([phase, samples]) => {
          const sorted = samples.toSorted((a, b) => a - b);
          const at = (fraction) =>
            sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
          return [
            phase,
            {
              count: sorted.length,
              p50: at(0.5),
              p95: at(0.95),
              p99: at(0.99),
              max: sorted.at(-1) ?? 0,
            },
          ];
        }),
      ),
    }),
  );
}, 250).unref();
