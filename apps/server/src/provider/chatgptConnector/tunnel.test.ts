// FILE: tunnel.test.ts
// Purpose: Unit tests for the ChatGPT connector tunnel supervisor and its pure helpers.
//          Uses a fake child process: no real processes, no network.
// Layer: Server provider / ChatGPT connector

import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatGptTunnelSupervisor,
  buildCloudflaredArgs,
  buildOpenAiTunnelEnv,
  extractCloudflaredUrl,
  resolveOnPath,
  type ChatGptTunnelChild,
  type ChatGptTunnelConfig,
  type ChatGptTunnelDependencies,
} from "./tunnel.ts";

const LOCAL_URL = "http://127.0.0.1:58090/mcp/chatgpt/secret-token";
const OPENAI_TUNNEL_ID = `tunnel_${"a".repeat(32)}`;
const OPENAI_API_KEY = "sk-test-secret-key";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

class FakeTunnelChild implements ChatGptTunnelChild {
  readonly pid: number | undefined = 41_000;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  autoExitOnKill = true;

  private readonly lifecycle = new EventEmitter();
  private readonly stdoutEvents = new EventEmitter();
  private readonly stderrEvents = new EventEmitter();
  private exitEmitted = false;

  constructor(streams = true) {
    this.stdout = streams ? (this.stdoutEvents as unknown as NodeJS.ReadableStream) : null;
    this.stderr = streams ? (this.stderrEvents as unknown as NodeJS.ReadableStream) : null;
  }

  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.lifecycle.on(event, listener);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (this.autoExitOnKill && !this.exitEmitted) {
      setTimeout(() => this.emitExit(null, signal ?? null), 0);
    }
    return true;
  }

  emitStdout(text: string): void {
    this.stdoutEvents.emit("data", Buffer.from(text, "utf8"));
  }

  emitStderr(text: string): void {
    this.stderrEvents.emit("data", Buffer.from(text, "utf8"));
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.lifecycle.emit("exit", code, signal);
  }

  emitError(error: Error): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.lifecycle.emit("error", error);
  }
}

interface TunnelSpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

interface TunnelHarness {
  readonly supervisor: ChatGptTunnelSupervisor;
  readonly spawns: TunnelSpawnRecord[];
  readonly children: FakeTunnelChild[];
  readonly child: () => FakeTunnelChild;
}

function createHarness(overrides: Partial<ChatGptTunnelDependencies> = {}): TunnelHarness {
  const spawns: TunnelSpawnRecord[] = [];
  const children: FakeTunnelChild[] = [];

  const spawn: ChatGptTunnelDependencies["spawn"] = (command, args, options) => {
    const child = new FakeTunnelChild();
    children.push(child);
    spawns.push({ command, args: [...args], env: options.env });
    return child;
  };

  const dependencies: ChatGptTunnelDependencies = {
    spawn: overrides.spawn ?? spawn,
    resolveBinary:
      overrides.resolveBinary ?? ((name, override) => override?.trim() || `/fake/bin/${name}`),
    now: overrides.now ?? (() => new Date("2026-01-02T03:04:05.000Z")),
    readyGraceMs: overrides.readyGraceMs ?? 20,
    readyTimeoutMs: overrides.readyTimeoutMs ?? 20,
  };

  return {
    supervisor: new ChatGptTunnelSupervisor(dependencies),
    spawns,
    children,
    child: () => {
      const child = children.at(-1);
      if (!child) throw new Error("No child process was spawned.");
      return child;
    },
  };
}

const supervisors: ChatGptTunnelSupervisor[] = [];

function makeHarness(overrides: Partial<ChatGptTunnelDependencies> = {}): TunnelHarness {
  const harness = createHarness(overrides);
  supervisors.push(harness.supervisor);
  return harness;
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.stop();
  }
});

const cloudflaredConfig: ChatGptTunnelConfig = { mode: "cloudflared", localUrl: LOCAL_URL };
const openAiConfig: ChatGptTunnelConfig = {
  mode: "openai",
  openAiTunnelId: OPENAI_TUNNEL_ID,
  openAiTunnelApiKey: OPENAI_API_KEY,
  localUrl: LOCAL_URL,
};

describe("extractCloudflaredUrl", () => {
  it("extracts the quick-tunnel URL from noisy output", () => {
    const output = [
      "2026-01-02T03:04:05Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-01-02T03:04:06Z INF |  https://smooth-dog-42.trycloudflare.com  |",
    ].join("\n");

    expect(extractCloudflaredUrl(output)).toBe("https://smooth-dog-42.trycloudflare.com");
  });

  it("returns null when there is no quick-tunnel URL", () => {
    expect(extractCloudflaredUrl("INF Registered tunnel connection connIndex=0")).toBeNull();
  });
});

describe("buildCloudflaredArgs", () => {
  it("targets the loopback origin and forwards the connector host header", () => {
    expect(buildCloudflaredArgs({ localUrl: LOCAL_URL })).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://127.0.0.1:58090",
      "--http-host-header",
      "127.0.0.1:58090",
    ]);
  });
});

describe("buildOpenAiTunnelEnv", () => {
  it("carries the key and channel URL in the environment, never in argv", () => {
    const env = buildOpenAiTunnelEnv({ localUrl: LOCAL_URL, apiKey: OPENAI_API_KEY });

    expect(env.CONTROL_PLANE_API_KEY).toBe(OPENAI_API_KEY);
    expect(env.MCP_SERVER_URL).toBe(`url=${LOCAL_URL},channel=main`);
  });
});

describe("resolveOnPath", () => {
  it.skipIf(process.platform === "win32")(
    "finds an executable on a fake PATH and rejects missing or non-executable files",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "synara-tunnel-"));
      try {
        const executable = join(dir, "cloudflared");
        const plainFile = join(dir, "tunnel-client");
        await writeFile(executable, "#!/bin/sh\n");
        await writeFile(plainFile, "#!/bin/sh\n");
        await chmod(executable, 0o755);
        await chmod(plainFile, 0o644);

        expect(resolveOnPath("cloudflared", { PATH: dir }, "darwin")).toBe(executable);
        expect(resolveOnPath("tunnel-client", { PATH: dir }, "darwin")).toBeNull();
        expect(resolveOnPath("cloudflared", { PATH: "" }, "darwin")).toBeNull();
        expect(resolveOnPath("cloudflared", { PATH: "/definitely/missing" }, "darwin")).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("resolves Windows executables using PATHEXT from the fake environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synara-tunnel-win-"));
    try {
      await writeFile(join(dir, "cloudflared.exe"), "");
      const resolved = resolveOnPath("cloudflared", { PATH: dir, PATHEXT: ".EXE" }, "win32");
      expect(resolved?.toLowerCase()).toBe(join(dir, "cloudflared.exe").toLowerCase());
      expect(resolveOnPath("cloudflared", { PATH: dir, PATHEXT: ".CMD" }, "win32")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ChatGptTunnelSupervisor", () => {
  it("starts out disabled", () => {
    const harness = makeHarness();

    expect(harness.supervisor.status()).toEqual({
      state: "off",
      publicUrl: null,
      message: "Tunnel disabled.",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("reports manual guidance without spawning a child and keeps it through stop", async () => {
    const harness = makeHarness();

    const status = await harness.supervisor.start({ mode: "manual", localUrl: LOCAL_URL });

    expect(status.state).toBe("manual");
    expect(status.publicUrl).toBeNull();
    expect(status.message).toContain(LOCAL_URL);
    expect(status.message).toContain("ChatGPT");
    expect(harness.children).toHaveLength(0);

    await harness.supervisor.stop();
    expect(harness.supervisor.status().state).toBe("manual");
    expect(harness.supervisor.status().message).toContain(LOCAL_URL);
  });

  it("switches to off and kills a running tunnel child", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(cloudflaredConfig);
    const child = harness.child();
    child.emitStdout("INF | https://quiet-forest.trycloudflare.com |\n");
    expect(harness.supervisor.status().state).toBe("connected");

    const status = await harness.supervisor.start({ mode: "off", localUrl: LOCAL_URL });

    expect(status.state).toBe("off");
    expect(status.message).toBe("Tunnel disabled.");
    expect(status.publicUrl).toBeNull();
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("connects a Cloudflare quick tunnel and preserves the connector secret path", async () => {
    const harness = makeHarness();

    const started = await harness.supervisor.start(cloudflaredConfig);

    expect(started.state).toBe("starting");
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]?.command).toBe("/fake/bin/cloudflared");
    expect(harness.spawns[0]?.args).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://127.0.0.1:58090",
      "--http-host-header",
      "127.0.0.1:58090",
    ]);

    harness.child().emitStdout("INF | https://smooth-dog-42.trycloudflare.com |\n");

    expect(harness.supervisor.status()).toMatchObject({
      state: "connected",
      publicUrl: "https://smooth-dog-42.trycloudflare.com/mcp/chatgpt/secret-token",
      message: "Cloudflare quick tunnel active.",
    });
  });

  it("assembles a URL split across stdout chunks", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(cloudflaredConfig);

    harness.child().emitStdout("INF | https://split-url-");
    harness.child().emitStdout("box.trycloudflare.com |\n");

    expect(harness.supervisor.status()).toMatchObject({
      state: "connected",
      publicUrl: "https://split-url-box.trycloudflare.com/mcp/chatgpt/secret-token",
    });
  });

  it("errors when cloudflared never reports a URL before the deadline", async () => {
    const harness = makeHarness({ readyTimeoutMs: 10 });
    await harness.supervisor.start(cloudflaredConfig);

    await vi.waitFor(() => {
      expect(harness.supervisor.status().state).toBe("error");
    });
    expect(harness.supervisor.status().message).toBe(
      "Cloudflare tunnel did not report a URL in time.",
    );
  });

  it("keeps the timeout error when a URL arrives after the deadline", async () => {
    const harness = makeHarness({ readyTimeoutMs: 10 });
    await harness.supervisor.start(cloudflaredConfig);
    await vi.waitFor(() => {
      expect(harness.supervisor.status().state).toBe("error");
    });

    harness.child().emitStdout("INF | https://late-dog.trycloudflare.com |\n");

    expect(harness.supervisor.status().state).toBe("error");
  });

  it("reports the last output line when the cloudflared child exits early", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(cloudflaredConfig);
    const child = harness.child();

    child.emitStderr("ERR Failed to serve tunnel connection\n");
    child.emitExit(1);

    expect(harness.supervisor.status()).toMatchObject({
      state: "error",
      publicUrl: null,
      message: "ERR Failed to serve tunnel connection",
    });
  });

  it("reports an error with the last output line when the child exits after connecting", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(cloudflaredConfig);
    const child = harness.child();
    child.emitStdout("INF | https://quiet-forest.trycloudflare.com |\n");
    expect(harness.supervisor.status().state).toBe("connected");

    child.emitStderr("ERR connection terminated\n");
    child.emitExit(1);

    expect(harness.supervisor.status()).toMatchObject({
      state: "error",
      publicUrl: null,
      message: "ERR connection terminated",
    });
  });

  it("bounds the reported last output line to 200 characters", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(cloudflaredConfig);
    const child = harness.child();
    const longLine = "E".repeat(300);

    child.emitStderr(`${longLine}\n`);
    child.emitExit(1);

    const message = harness.supervisor.status().message ?? "";
    expect(message).toHaveLength(200);
    expect(message).toBe(longLine.slice(0, 200));
  });

  it("reports a child spawn error", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(cloudflaredConfig);

    harness.child().emitError(new Error("spawn ENOENT"));

    expect(harness.supervisor.status()).toMatchObject({
      state: "error",
      message: "Could not start cloudflared: spawn ENOENT",
    });
  });

  it("errors when the cloudflared binary cannot be resolved", async () => {
    const harness = makeHarness({ resolveBinary: () => null });

    const status = await harness.supervisor.start(cloudflaredConfig);

    expect(status.state).toBe("error");
    expect(status.message).toContain("not found");
    expect(harness.spawns).toHaveLength(0);
  });

  it("errors when the local connector URL is invalid", async () => {
    const harness = makeHarness();

    const status = await harness.supervisor.start({
      mode: "cloudflared",
      localUrl: "not a url",
    });

    expect(status.state).toBe("error");
    expect(status.message).toContain("not a valid URL");
    expect(harness.spawns).toHaveLength(0);
  });

  it("rejects malformed OpenAI tunnel ids without spawning", async () => {
    const harness = makeHarness();

    const malformed = await harness.supervisor.start({
      ...openAiConfig,
      openAiTunnelId: "tunnel_XYZ",
    });
    const uppercase = await harness.supervisor.start({
      ...openAiConfig,
      openAiTunnelId: `tunnel_${"A".repeat(32)}`,
    });

    expect(malformed).toMatchObject({
      state: "error",
      message: "Enter a tunnel ID that looks like tunnel_ followed by 32 hex characters.",
    });
    expect(uppercase.state).toBe("error");
    expect(harness.spawns).toHaveLength(0);
  });

  it("requires an OpenAI tunnel API key", async () => {
    const harness = makeHarness();

    const status = await harness.supervisor.start({
      mode: "openai",
      openAiTunnelId: OPENAI_TUNNEL_ID,
      localUrl: LOCAL_URL,
    });

    expect(status).toMatchObject({
      state: "error",
      message: "Add your OpenAI tunnel API key first.",
    });
    expect(harness.spawns).toHaveLength(0);
  });

  it("connects the OpenAI tunnel after the ready grace with the key kept out of argv", async () => {
    const harness = makeHarness({ readyGraceMs: 10 });

    const started = await harness.supervisor.start(openAiConfig);

    expect(started.state).toBe("starting");
    const spawnRecord = harness.spawns[0];
    expect(spawnRecord?.command).toBe("/fake/bin/tunnel-client");
    expect(spawnRecord?.args).toEqual([
      "run",
      "--control-plane.tunnel-id",
      OPENAI_TUNNEL_ID,
      "--health.listen-addr",
      "127.0.0.1:0",
      "--log.format",
      "json",
      "--log.level",
      "info",
    ]);
    expect(spawnRecord?.args).not.toContain(OPENAI_API_KEY);
    expect(spawnRecord?.env.CONTROL_PLANE_API_KEY).toBe(OPENAI_API_KEY);
    expect(spawnRecord?.env.MCP_SERVER_URL).toBe(`url=${LOCAL_URL},channel=main`);

    await vi.waitFor(() => {
      expect(harness.supervisor.status().state).toBe("connected");
    });
    const status = harness.supervisor.status();
    expect(status.publicUrl).toBeNull();
    expect(status.message).toContain("managed by OpenAI");
    expect(status.message).toContain("private");
  });

  it("errors with the exit code when the OpenAI client exits during the grace", async () => {
    const harness = makeHarness({ readyGraceMs: 50 });
    await harness.supervisor.start(openAiConfig);

    harness.child().emitExit(3);

    expect(harness.supervisor.status()).toMatchObject({
      state: "error",
      message: "OpenAI tunnel exited (code 3).",
    });

    await delay(80);
    expect(harness.supervisor.status().state).toBe("error");
  });

  it("errors when the OpenAI client logs an error during the grace", async () => {
    const harness = makeHarness({ readyGraceMs: 10 });
    await harness.supervisor.start(openAiConfig);

    harness.child().emitStderr('{"level":"error","msg":"control plane rejected the key"}\n');

    await vi.waitFor(() => {
      expect(harness.supervisor.status().state).toBe("error");
    });
    expect(harness.supervisor.status().message).toBe(
      '{"level":"error","msg":"control plane rejected the key"}',
    );
  });

  it("stops the running child before starting a replacement mode", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(cloudflaredConfig);
    const first = harness.child();
    first.emitStdout("INF | https://first-dog.trycloudflare.com |\n");

    await harness.supervisor.start(openAiConfig);

    expect(first.kills).toEqual(["SIGTERM"]);
    expect(harness.children).toHaveLength(2);
    expect(harness.spawns[1]?.command).toBe("/fake/bin/tunnel-client");
  });

  it("kill, waits for exit and reports stopped", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(cloudflaredConfig);
    const child = harness.child();
    child.emitStdout("INF | https://quiet-forest.trycloudflare.com |\n");

    await harness.supervisor.stop();

    expect(child.kills).toEqual(["SIGTERM"]);
    expect(harness.supervisor.status()).toEqual({
      state: "stopped",
      publicUrl: null,
      message: "Tunnel stopped.",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("stop resolves after the bounded timeout when the child ignores SIGTERM", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(cloudflaredConfig);
    const child = harness.child();
    child.autoExitOnKill = false;

    const startedAt = Date.now();
    await harness.supervisor.stop();

    expect(child.kills).toEqual(["SIGTERM"]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_800);
    expect(harness.supervisor.status().state).toBe("stopped");
  });

  it("keeps the off state through stop", async () => {
    const harness = makeHarness();
    await harness.supervisor.start({ mode: "off", localUrl: LOCAL_URL });

    await harness.supervisor.stop();

    expect(harness.supervisor.status().state).toBe("off");
    expect(harness.supervisor.status().message).toBe("Tunnel disabled.");
  });

  it("allows a fresh start after stop", async () => {
    const harness = makeHarness();
    await harness.supervisor.start(cloudflaredConfig);
    await harness.supervisor.stop();

    await harness.supervisor.start(cloudflaredConfig);
    harness.child().emitStdout("INF | https://second-dog.trycloudflare.com |\n");

    expect(harness.children).toHaveLength(2);
    expect(harness.supervisor.status()).toMatchObject({
      state: "connected",
      publicUrl: "https://second-dog.trycloudflare.com/mcp/chatgpt/secret-token",
    });
  });

  it("tolerates a child without output streams", async () => {
    const harness = makeHarness({
      spawn: () => new FakeTunnelChild(false),
    });

    const status = await harness.supervisor.start(cloudflaredConfig);

    expect(status.state).toBe("starting");
  });
});
