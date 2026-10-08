import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, chmod, rm, readdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import {
  DEFAULT_SERVER_SETTINGS,
  WS_CLIENT_REQUIRED_CAPABILITIES,
  WS_COMPATIBILITY_QUERY,
  WS_NEGOTIATE_HTTP_PATH,
  WS_NEGOTIATE_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
} from "@synara/contracts";
import { execProcessFile, spawnProcess } from "@synara/shared/processRuntime";
import {
  teardownChildProcessTree,
  teardownProviderProcessTree,
} from "../src/platform/supervisedProcessTeardown";
import { MAX_THREAD_STREAMS_PER_RPC_CLIENT } from "../src/wsStreamAdmission";

export function summarize(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? 0,
  };
}

export function peakOverlap(streams: readonly { started: number; ended: number }[]) {
  const events = streams
    .flatMap(
      ({ started, ended }) =>
        [
          [started, 1],
          [ended, -1],
        ] as const,
    )
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let peak = 0;
  for (const [, change] of events) {
    active += change;
    peak = Math.max(peak, active);
  }
  return peak;
}

export function loadOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      threads: { type: "string", default: "20" },
      rate: { type: "string", default: "100" },
      seconds: { type: "string", default: "10" },
      output: { type: "string" },
      "keep-home": { type: "boolean", default: false },
      baseline: { type: "boolean", default: false },
      "baseline-ref": { type: "string", default: "e31ce661d" },
      "staggered-start": { type: "boolean", default: false },
    },
  });
  const threads = Number(values.threads);
  const rate = Number(values.rate);
  const seconds = Number(values.seconds);
  assert(
    Number.isInteger(threads) && threads >= 1 && threads <= 64,
    "threads must be an integer between 1 and 64",
  );
  assert(
    Number.isInteger(rate) && rate >= 1 && rate <= 500,
    "rate must be an integer between 1 and 500",
  );
  assert(
    Number.isFinite(seconds) && seconds >= 1 && seconds <= 300,
    "seconds must be between 1 and 300",
  );
  return {
    threads,
    rate,
    seconds,
    ticks: Math.floor(rate * seconds),
    output: values.output,
    keepHome: values["keep-home"],
    baseline: values.baseline,
    baselineRef: values["baseline-ref"],
    staggeredStart: values["staggered-start"],
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function vacantPort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  // A port occupied on IPv6 must not be selected for an isolated instance.
  const ipv6 = net.createServer();
  try {
    await new Promise<void>((resolve, reject) =>
      ipv6.once("error", reject).listen(port, "::1", resolve),
    );
    await new Promise<void>((resolve) => ipv6.close(() => resolve()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return vacantPort();
    if ((error as NodeJS.ErrnoException).code !== "EAFNOSUPPORT") throw error;
  }
  return port;
}

async function command(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<string>((resolve, reject) =>
    execProcessFile(
      command,
      args,
      { env, cwd, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
    ),
  );
}

async function connect(origin: string, token: string) {
  const negotiate = new URL(WS_NEGOTIATE_HTTP_PATH, origin);
  negotiate.searchParams.set("token", token);
  negotiate.searchParams.set(WS_NEGOTIATE_QUERY.clientBuild, "orchestration-load-fixture");
  negotiate.searchParams.set(WS_NEGOTIATE_QUERY.protocolEpoch, String(WS_PROTOCOL_EPOCH));
  negotiate.searchParams.set(WS_NEGOTIATE_QUERY.minRevision, String(WS_PROTOCOL_MIN_REVISION));
  negotiate.searchParams.set(WS_NEGOTIATE_QUERY.maxRevision, String(WS_PROTOCOL_MAX_REVISION));
  for (const capability of WS_CLIENT_REQUIRED_CAPABILITIES)
    negotiate.searchParams.append(WS_NEGOTIATE_QUERY.requiredCapability, capability);
  let response: Response | undefined;
  const deadline = performance.now() + 45_000;
  while (performance.now() < deadline) {
    try {
      response = await fetch(negotiate, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) break;
    } catch {}
    await sleep(100);
  }
  assert(response?.ok, "isolated server did not become ready");
  const compatibility = (await response.json()) as {
    protocolEpoch: number;
    negotiatedRevision: number;
    serverInstanceId: string;
  };
  const url = new URL("/ws", origin);
  url.protocol = "ws:";
  url.searchParams.set("token", token);
  url.searchParams.set(WS_COMPATIBILITY_QUERY.clientBuild, "orchestration-load-fixture");
  url.searchParams.set(WS_COMPATIBILITY_QUERY.protocolEpoch, String(compatibility.protocolEpoch));
  url.searchParams.set(
    WS_COMPATIBILITY_QUERY.protocolRevision,
    String(compatibility.negotiatedRevision),
  );
  url.searchParams.set(WS_COMPATIBILITY_QUERY.serverInstanceId, compatibility.serverInstanceId);
  const socket = new WebSocket(url, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 0;
  let receivedBytes = 0;
  let receivedFrames = 0;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const streamFrames = new Map<string, number>();
  const completedThreads = new Map<string, number>();
  const firstAssistantText = new Map<string, number>();
  socket.on("message", (data) => {
    receivedBytes += Buffer.byteLength(data.toString());
    receivedFrames += 1;
    const frame = JSON.parse(data.toString());
    if (frame._tag === "Chunk") {
      for (const value of frame.values ?? []) {
        if (value.kind === "thread-upserted" && value.thread.latestTurn?.state === "completed") {
          if (!completedThreads.has(value.thread.id))
            completedThreads.set(value.thread.id, performance.now());
        }
        if (
          value.kind === "event" &&
          value.event.type === "thread.message-sent" &&
          value.event.payload.role === "assistant" &&
          value.event.payload.text
        ) {
          if (!firstAssistantText.has(value.event.payload.threadId))
            firstAssistantText.set(value.event.payload.threadId, performance.now());
        }
      }
      streamFrames.set(
        String(frame.requestId),
        (streamFrames.get(String(frame.requestId)) ?? 0) + 1,
      );
      socket.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
    }
    if (frame._tag !== "Exit") return;
    const request = pending.get(String(frame.requestId));
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(String(frame.requestId));
    if (frame.exit._tag === "Success") request.resolve(frame.exit.value);
    else request.reject(new Error(JSON.stringify(frame.exit)));
  });
  socket.on("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("load fixture socket closed"));
    }
    pending.clear();
  });
  const request = (tag: string, payload: unknown, stream = false): Promise<unknown> => {
    const id = String(++nextId);
    if (stream) {
      streamFrames.set(id, 0);
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      return Promise.resolve(id);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC ${tag} timed out`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  };
  return {
    request,
    close: () => socket.close(),
    metrics: () => ({
      receivedBytes,
      receivedFrames,
      streamFrames: [...streamFrames.values()],
      completedThreads,
      firstAssistantText,
    }),
  };
}

async function fileSize(file: string) {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export async function runLoad(options: ReturnType<typeof loadOptions>) {
  const root = path.resolve(import.meta.dirname, "../../..");
  const home = await mkdtemp(path.join(os.tmpdir(), "synara-orchestration-load-"));
  const codexHome = path.join(home, "codex");
  const workspace = path.join(home, "workspace");
  const metricsPath = path.join(home, "server-metrics.json");
  const dbPath = path.join(home, "userdata/state.sqlite");
  await Promise.all([mkdir(codexHome), mkdir(workspace), mkdir(path.dirname(dbPath))]);
  const fixture = path.join(import.meta.dirname, "orchestration-load/fake-codex.mjs");
  let binary = fixture;
  if (process.platform === "win32") {
    binary = path.join(home, "fake-codex.cmd");
    await writeFile(binary, `@node "${fixture}" %*\r\n`);
  } else await chmod(fixture, 0o755);
  await writeFile(
    path.join(codexHome, "load-fixture.json"),
    JSON.stringify({
      ticks: options.ticks,
      intervalMs: 1000 / options.rate,
      barrier: !options.staggeredStart,
    }),
  );
  const settings = {
    ...structuredClone(DEFAULT_SERVER_SETTINGS),
    providers: {
      ...Object.fromEntries(
        Object.entries(DEFAULT_SERVER_SETTINGS.providers).map(([key, provider]) => [
          key,
          { ...provider, enabled: false },
        ]),
      ),
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        enabled: true,
        binaryPath: binary,
        homePath: codexHome,
      },
    },
  };
  await writeFile(
    path.join(home, "userdata/settings.json"),
    JSON.stringify({ revision: 0, migrationVersion: 5, settings }),
  );
  const port = await vacantPort();
  const webPort = await vacantPort();
  const token = `load-fixture-${crypto.randomUUID()}`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: os.tmpdir(),
    SYNARA_HOME: home,
    CODEX_HOME: codexHome,
    SYNARA_NO_BROWSER: "1",
    SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    SYNARA_LOAD_METRICS: metricsPath,
  };
  let server: ReturnType<typeof spawnProcess> | undefined;
  let cleanupAttempted = false;
  let cleanupVerified = false;
  let resultWritten = false;
  const clients: Awaited<ReturnType<typeof connect>>[] = [];
  let logs = "";
  const cleanup = async () => {
    assert(server);
    cleanupAttempted = true;
    const result = await teardownChildProcessTree(server, (input) =>
      teardownProviderProcessTree({ ...input, termGraceMs: 10_000, forceExitMs: 5_000 }),
    );
    cleanupVerified = true;
    return result;
  };
  try {
    const baselineFiles: string[] = [];
    if (options.baseline) {
      const changed = await command(
        "git",
        [
          "diff",
          "--name-only",
          options.baselineRef,
          "--",
          "apps/server/src",
          "packages/shared/src",
          "packages/contracts/src",
        ],
        env,
        root,
      );
      const sources: Record<string, string> = {};
      for (const file of changed
        .trim()
        .split("\n")
        .filter((file) => /\.[cm]?tsx?$/.test(file) && !file.endsWith(".test.ts"))) {
        sources[path.join(root, file)] = await command(
          "git",
          ["show", `${options.baselineRef}:${file}`],
          env,
          root,
        );
        baselineFiles.push(file);
      }
      env.SYNARA_LOAD_BASELINE = path.join(home, "baseline-sources.json");
      await writeFile(env.SYNARA_LOAD_BASELINE, JSON.stringify(sources));
    }
    const dryRun = await command(
      process.execPath,
      [
        "scripts/dev-runner.ts",
        "dev:server",
        "--home-dir",
        home,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--dev-url",
        `http://127.0.0.1:${webPort}`,
        "--no-browser",
        "--dry-run",
      ],
      env,
      root,
    );
    assert(
      dryRun.includes(home) && dryRun.includes(`serverPort=${port}`),
      "dev-runner selected the wrong isolation settings",
    );
    console.error(dryRun.trim());
    await command("git", ["init", "-q", workspace], env, root);
    await command(
      "git",
      [
        "-C",
        workspace,
        "-c",
        "user.name=Load fixture",
        "-c",
        "user.email=load@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
      ],
      env,
      root,
    );
    server = spawnProcess(
      process.execPath,
      [
        "--preload",
        path.join(import.meta.dirname, "orchestration-load/server-metrics.mjs"),
        "apps/server/src/index.ts",
        "--home-dir",
        home,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--auth-token",
        token,
        "--no-browser",
      ],
      { cwd: root, env, stdio: "pipe" },
    );
    assert(server.stdout && server.stderr);
    server.stdout.on("data", (chunk) => {
      logs = (logs + chunk.toString()).slice(-64_000);
    });
    server.stderr.on("data", (chunk) => {
      logs = (logs + chunk.toString()).slice(-64_000);
    });
    for (
      let index = 0;
      index < Math.ceil(options.threads / MAX_THREAD_STREAMS_PER_RPC_CLIENT);
      index += 1
    ) {
      clients.push(await connect(`http://127.0.0.1:${port}`, token));
    }
    const rpc = clients[0]!.request;
    const createdAt = new Date().toISOString();
    const selection = { provider: "codex", instanceId: "codex", model: "gpt-5.5" };
    let commandNumber = 0;
    const rpcForThread = (threadId: string) =>
      clients[Math.floor(Number(threadId.split("-").at(-1)) / MAX_THREAD_STREAMS_PER_RPC_CLIENT)]!
        .request;
    const dispatch = (payload: Record<string, unknown>) =>
      (typeof payload.threadId === "string" ? rpcForThread(payload.threadId) : rpc)(
        "orchestration.dispatchCommand",
        {
          ...payload,
          commandId: `load-command-${++commandNumber}`,
        },
      );
    await dispatch({
      type: "project.create",
      projectId: "load-project",
      title: "Load fixture",
      workspaceRoot: workspace,
      createdAt,
    });
    const threadIds = Array.from({ length: options.threads }, (_, index) => `load-thread-${index}`);
    for (const threadId of threadIds) {
      await dispatch({
        type: "thread.create",
        threadId,
        projectId: "load-project",
        title: threadId,
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      await rpcForThread(threadId)("orchestration.subscribeThread", { threadId }, true);
    }
    await rpc("orchestration.subscribeShell", {}, true);
    const initialSizes = { db: await fileSize(dbPath), wal: await fileSize(`${dbPath}-wal`) };
    const peaks = { ...initialSizes };
    const snapshotLatency: number[] = [];
    const sendLatency: number[] = [];
    const providerCompletionLatency: number[] = [];
    const start = performance.now();
    await writeFile(`${metricsPath}.active`, "");
    if (options.staggeredStart) await writeFile(`${metricsPath}.streaming`, "");
    const polling = { active: true };
    let pollingError: unknown;
    const pollingTask = (async () => {
      let index = 0;
      while (polling.active) {
        const before = performance.now();
        await rpc("orchestration.getThreadDetailSnapshot", {
          threadId: threadIds[index++ % threadIds.length],
        });
        snapshotLatency.push(performance.now() - before);
        peaks.db = Math.max(peaks.db, await fileSize(dbPath));
        peaks.wal = Math.max(peaks.wal, await fileSize(`${dbPath}-wal`));
        await sleep(100);
      }
    })().catch((error) => {
      pollingError = error;
      polling.active = false;
    });
    await Promise.all(
      threadIds.map(async (threadId) => {
        const before = performance.now();
        await dispatch({
          type: "thread.turn.start",
          threadId,
          message: {
            messageId: `${threadId}-user`,
            role: "user",
            text: "Run the reproducible load fixture",
            attachments: [],
          },
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        });
        sendLatency.push(performance.now() - before);
      }),
    );
    const readyDeadline = performance.now() + 60_000;
    while (
      (await readdir(codexHome)).filter((file) => /^stream-\d+\.json$/.test(file)).length <
      options.threads
    ) {
      assert(
        performance.now() < readyDeadline,
        "fake providers did not all reach the stream barrier",
      );
      await sleep(25);
    }
    const startupMs = performance.now() - start;
    await writeFile(`${metricsPath}.streaming`, "");
    await writeFile(path.join(codexHome, "stream-go"), "");
    const expectedText = Array.from(
      { length: options.ticks },
      (_, index) => `token-${index} `,
    ).join("");
    const unfinished = new Set(threadIds);
    const deadline = performance.now() + options.seconds * 1000 + 90_000;
    while (unfinished.size && performance.now() < deadline) {
      if (pollingError) throw pollingError;
      for (const threadId of unfinished) {
        if (!clients.some((client) => client.metrics().completedThreads.has(threadId))) continue;
        const snapshot = (await rpc("orchestration.getThreadDetailSnapshot", { threadId })) as {
          thread: {
            messages: { role: string; text: string }[];
            latestTurn: { state?: string; status?: string } | null;
            activities: unknown[];
          };
        };
        assert(snapshot.thread.latestTurn?.state !== "error", `provider failed in ${threadId}`);
        if (
          snapshot.thread.messages.some(
            (message) => message.role === "assistant" && message.text === expectedText,
          ) &&
          (snapshot.thread.latestTurn?.state === "completed" ||
            snapshot.thread.latestTurn?.status === "completed")
        ) {
          assert(snapshot.thread.activities.length > 0, "tool/file activities were not persisted");
          unfinished.delete(threadId);
          providerCompletionLatency.push(
            clients
              .flatMap((client) => [...client.metrics().completedThreads])
              .find(([id]) => id === threadId)![1] - start,
          );
        }
      }
      if (unfinished.size) await sleep(250);
    }
    polling.active = false;
    await pollingTask;
    if (pollingError) throw pollingError;
    await sleep(300);
    const serverMetrics = JSON.parse(await readFile(metricsPath, "utf8"));
    assert(serverMetrics.sampleCount > 0, "server event-loop measurements are missing");
    const connectionMetrics = clients.map((client) => client.metrics());
    const firstTextLatency = connectionMetrics
      .flatMap((entry) => [...entry.firstAssistantText.values()])
      .map((at) => at - start);
    const transport = {
      connections: clients.length,
      receivedBytes: connectionMetrics.reduce((total, entry) => total + entry.receivedBytes, 0),
      receivedFrames: connectionMetrics.reduce((total, entry) => total + entry.receivedFrames, 0),
      streamFrames: connectionMetrics.flatMap((entry) => entry.streamFrames),
    };
    assert(
      transport.streamFrames.every((count) => count > 0),
      "a thread/shell subscription received no stream frames",
    );
    const finalSizes = { db: await fileSize(dbPath), wal: await fileSize(`${dbPath}-wal`) };
    const wallMs = performance.now() - start;
    const streams = await Promise.all(
      (await readdir(codexHome))
        .filter((file) => /^stream-\d+\.json$/.test(file))
        .map(
          async (file) =>
            JSON.parse(await readFile(path.join(codexHome, file), "utf8")) as {
              ready: number;
              started: number;
              ended: number;
              startedRssBytes: number;
              endedRssBytes: number;
            },
        ),
    );
    const overlap = peakOverlap(
      streams.filter((stream) => Number.isFinite(stream.started) && Number.isFinite(stream.ended)),
    );
    const changedFiles = (await readdir(workspace)).filter((file) => /^load-\d+\.ts$/.test(file));
    for (const file of changedFiles)
      assert.equal(
        await readFile(path.join(workspace, file), "utf8"),
        "export const loadResult = true;\n",
      );
    for (const client of clients.splice(0)) client.close();
    const shutdown = await cleanup();
    server = undefined;
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    let rows;
    try {
      rows = {
        orchestration: db.query("SELECT COUNT(*) AS count FROM orchestration_events").get(),
        providerRuntime: db.query("SELECT COUNT(*) AS count FROM provider_runtime_events").get(),
      };
    } finally {
      db.close();
    }
    const result = {
      fixture: "fake Codex app-server; real Synara server, SQLite and WebSocket",
      streamingMode: options.staggeredStart ? "staggered" : "barrier",
      runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
      shutdown,
      source: {
        baseline: options.baseline,
        baselineRef: options.baseline ? options.baselineRef : null,
        baselineFiles,
        revision: (await command("git", ["rev-parse", "HEAD"], env, root)).trim(),
      },
      options: {
        threads: options.threads,
        rate: options.rate,
        seconds: options.seconds,
        ticks: options.ticks,
      },
      completedThreads: threadIds.length - unfinished.size,
      incompleteThreads: [...unfinished],
      changedFiles: changedFiles.length,
      rawProviderDeltas: {
        assistant: options.threads * options.ticks,
        commandOutput: options.threads * Math.ceil(options.ticks / 4),
        fileChangeOutput: options.threads,
      },
      wallMs,
      startupMs,
      fakeProviders: {
        peakStreamingThreads: overlap,
        rssBytes: summarize(
          streams.map((stream) => Math.max(stream.startedRssBytes, stream.endedRssBytes)),
        ),
        emissionMs: summarize(streams.map((stream) => stream.ended - stream.started)),
      },
      server: serverMetrics,
      wsLatencyMs: {
        loadThread: summarize(snapshotLatency),
        sendMessageReceipt: summarize(sendLatency),
        firstAssistantText: summarize(firstTextLatency),
        completion: summarize(providerCompletionLatency),
      },
      transport,
      storageBytes: { initial: initialSizes, peak: peaks, final: finalSizes, rows },
      ...(options.keepHome ? { isolatedHome: home } : {}),
    };
    if (options.output) {
      await writeFile(path.resolve(options.output), `${JSON.stringify(result, null, 2)}\n`);
      resultWritten = true;
    }
    console.log(JSON.stringify(result, null, 2));
    assert.equal(unfinished.size, 0, `incomplete threads: ${[...unfinished].join(", ")}`);
    if (!options.staggeredStart)
      assert.equal(overlap, options.threads, "fake providers did not all stream concurrently");
    assert.equal(
      changedFiles.length,
      options.threads,
      "a fake provider did not produce its file change",
    );
    return result;
  } catch (error) {
    let cleanupError: unknown;
    if (server && !cleanupAttempted) {
      try {
        await cleanup();
      } catch (error) {
        cleanupError = error;
      }
    }
    console.error(logs.replaceAll(token, "[load fixture token]"));
    if (cleanupError) console.error(String(cleanupError).replaceAll(token, "[load fixture token]"));
    if (server && !cleanupVerified)
      console.error(`Unverified exit; isolated home retained: ${home}`);
    if (options.output) {
      const existing = resultWritten ? await readFile(path.resolve(options.output), "utf8") : "{}";
      const metrics = await readFile(metricsPath, "utf8").catch(() => "null");
      const failureResult = {
        ...JSON.parse(existing),
        runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
        options,
        error: String(error).replaceAll(token, "[load fixture token]"),
        ...(cleanupError
          ? { cleanupError: String(cleanupError).replaceAll(token, "[load fixture token]") }
          : {}),
        ...(options.keepHome || (server && !cleanupVerified) ? { isolatedHome: home } : {}),
        server: JSON.parse(metrics),
        logTail: logs.replaceAll(token, "[load fixture token]").slice(-8_000),
      };
      await writeFile(path.resolve(options.output), `${JSON.stringify(failureResult, null, 2)}\n`);
    }
    throw error;
  } finally {
    for (const client of clients) client.close();
    if (server && !cleanupAttempted) await cleanup();
    if (!options.keepHome && (!server || cleanupVerified))
      await rm(home, { recursive: true, force: true });
  }
}

if (import.meta.main) await runLoad(loadOptions(process.argv.slice(2)));
