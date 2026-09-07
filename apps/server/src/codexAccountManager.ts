import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import type {
  CodexAccountLoginTarget,
  CodexProfileId,
  ServerCodexAccountState,
} from "@synara/contracts";

import { ensureManagedCodexProfileHome } from "./codexProfiles.ts";
import { resolveExecutable } from "./executableLookup.ts";
import { redactSensitiveProcessArgs } from "./processArgumentRedaction.ts";

const DEVICE_LOGIN_TIMEOUT_MS = 20_000;
const BRIDGE_START_TIMEOUT_MS = 10_000;
const MAX_PROCESS_OUTPUT_CHARS = 8_000;

interface LoginProcess {
  child: ChildProcessWithoutNullStreams;
  target: CodexAccountLoginTarget;
  verificationUrl?: string;
  userCode?: string;
  output: string;
}

interface BridgeProcess {
  child: ChildProcessWithoutNullStreams;
  port: number;
  status: "starting" | "running" | "error";
  detail?: string;
}

const loginErrorKey = (profileId: CodexProfileId, target: CodexAccountLoginTarget): string =>
  `${profileId}:${target}`;

function appendBounded(current: string, chunk: string): string {
  const next = `${current}${stripVTControlCharacters(String(chunk))}`;
  return next.length > MAX_PROCESS_OUTPUT_CHARS ? next.slice(-MAX_PROCESS_OUTPUT_CHARS) : next;
}

function safeProcessDetail(output: string, fallback: string): string {
  return redactSensitiveProcessArgs(output.trim() || fallback);
}

async function hasAuthFile(filePath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("close", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000).unref();
  });
}

export class CodexAccountManager {
  private readonly logins = new Map<CodexProfileId, LoginProcess>();
  private readonly bridges = new Map<CodexProfileId, BridgeProcess>();
  private readonly loginErrors = new Map<string, string>();

  constructor(
    private readonly secretsDir: string,
    private readonly onCodexAuthChanged: () => void = () => {},
  ) {}

  private profileHome(profileId: CodexProfileId): string {
    return path.join(this.secretsDir, "codex-profiles", profileId);
  }

  private proxyConfigDir(profileId: CodexProfileId): string {
    return path.join(this.profileHome(profileId), "claude-code-proxy");
  }

  private async isSignedIn(
    profileId: CodexProfileId,
    target: CodexAccountLoginTarget,
  ): Promise<boolean> {
    const authPath =
      target === "codex"
        ? path.join(this.profileHome(profileId), "auth.json")
        : path.join(this.proxyConfigDir(profileId), "codex", "auth.json");
    return hasAuthFile(authPath);
  }

  async getState(input: {
    profileId: CodexProfileId;
    proxyBinaryPath: string;
  }): Promise<ServerCodexAccountState> {
    const login = this.logins.get(input.profileId);
    const bridge = this.bridges.get(input.profileId);
    const [codexSignedIn, proxySignedIn] = await Promise.all([
      this.isSignedIn(input.profileId, "codex"),
      this.isSignedIn(input.profileId, "claude-code"),
    ]);
    const proxyInstalled = Boolean(
      resolveExecutable(input.proxyBinaryPath || "claude-code-proxy", { env: process.env }),
    );
    const codexLoginError = this.loginErrors.get(loginErrorKey(input.profileId, "codex"));
    const proxyLoginError = this.loginErrors.get(loginErrorKey(input.profileId, "claude-code"));
    const result: ServerCodexAccountState = {
      profileId: input.profileId,
      codexAuth:
        login?.target === "codex"
          ? "signing-in"
          : codexSignedIn
            ? "signed-in"
            : codexLoginError
              ? "error"
              : "signed-out",
      claudeCodeAuth:
        login?.target === "claude-code"
          ? "signing-in"
          : proxySignedIn
            ? "signed-in"
            : proxyLoginError
              ? "error"
              : "signed-out",
      proxyInstalled,
      bridgeStatus: bridge?.status ?? "stopped",
      ...(bridge?.status === "running" ? { launchCommand: this.launchCommand(bridge.port) } : {}),
      ...(login ? { loginTarget: login.target } : {}),
      ...(login?.verificationUrl ? { verificationUrl: login.verificationUrl } : {}),
      ...(login?.userCode ? { userCode: login.userCode } : {}),
      ...(bridge?.detail || codexLoginError || proxyLoginError
        ? { detail: bridge?.detail ?? codexLoginError ?? proxyLoginError }
        : {}),
    };
    return result;
  }

  async startLogin(input: {
    profileId: CodexProfileId;
    target: CodexAccountLoginTarget;
    codexBinaryPath: string;
    proxyBinaryPath: string;
  }): Promise<ServerCodexAccountState> {
    await this.cancelLogin(input.profileId);
    const errorKey = loginErrorKey(input.profileId, input.target);
    this.loginErrors.delete(errorKey);
    const profileHome = await ensureManagedCodexProfileHome(this.secretsDir, input.profileId);
    const proxyConfigDir = this.proxyConfigDir(input.profileId);
    if (input.target === "claude-code") {
      await fs.mkdir(proxyConfigDir, { recursive: true, mode: 0o700 });
      await fs.chmod(proxyConfigDir, 0o700);
    }
    const configuredBinary =
      input.target === "codex"
        ? input.codexBinaryPath || "codex"
        : input.proxyBinaryPath || "claude-code-proxy";
    const args =
      input.target === "codex"
        ? ["login", "--device-auth", "-c", 'cli_auth_credentials_store="file"']
        : ["codex", "auth", "device"];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(input.target === "codex"
        ? { CODEX_HOME: profileHome }
        : { CCP_CONFIG_DIR: proxyConfigDir }),
    };
    delete env.OPENAI_API_KEY;
    const binary = resolveExecutable(configuredBinary, { env });
    if (!binary) {
      throw new Error(
        `${input.target === "codex" ? "Codex" : "Claude Code proxy"} binary '${configuredBinary}' was not found.`,
      );
    }
    const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    const login: LoginProcess = { child, target: input.target, output: "" };
    this.logins.set(input.profileId, login);

    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const parse = (chunk: Buffer | string) => {
        login.output = appendBounded(login.output, String(chunk));
        const verificationUrl = /https:\/\/auth\.openai\.com\/codex\/device\b/.exec(
          login.output,
        )?.[0];
        const userCode = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/.exec(login.output)?.[0];
        if (!login.verificationUrl && verificationUrl) login.verificationUrl = verificationUrl;
        if (!login.userCode && userCode) login.userCode = userCode;
        if (login.verificationUrl && login.userCode) finish();
      };
      child.stdout.on("data", parse);
      child.stderr.on("data", parse);
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (!settled) {
          finish(
            new Error(
              safeProcessDetail(login.output, `Login exited with code ${code ?? "unknown"}.`),
            ),
          );
        }
      });
      const timer = setTimeout(
        () => finish(new Error("Timed out waiting for the device login code.")),
        DEVICE_LOGIN_TIMEOUT_MS,
      );
      timer.unref();
    });

    child.once("close", async (code) => {
      if (this.logins.get(input.profileId)?.child !== child) return;
      this.logins.delete(input.profileId);
      if (code !== 0 && !(await this.isSignedIn(input.profileId, input.target))) {
        this.loginErrors.set(
          errorKey,
          safeProcessDetail(login.output, `Login exited with code ${code ?? "unknown"}.`),
        );
      } else {
        this.loginErrors.delete(errorKey);
      }
      if (input.target === "codex") this.onCodexAuthChanged();
    });

    try {
      await ready;
    } catch (error) {
      const detail = safeProcessDetail(
        error instanceof Error ? error.message : String(error),
        "Login failed.",
      );
      this.loginErrors.set(errorKey, detail);
      await this.cancelLogin(input.profileId);
      throw new Error(detail);
    }
    return this.getState(input);
  }

  async cancelLogin(profileId: CodexProfileId): Promise<void> {
    const login = this.logins.get(profileId);
    if (!login) return;
    this.logins.delete(profileId);
    await waitForExit(login.child);
  }

  async logout(profileId: CodexProfileId, target: CodexAccountLoginTarget): Promise<void> {
    await this.cancelLogin(profileId);
    if (target === "codex") {
      await fs.rm(path.join(this.profileHome(profileId), "auth.json"), { force: true });
    } else {
      await this.stopBridge(profileId);
      await fs.rm(path.join(this.proxyConfigDir(profileId), "codex", "auth.json"), {
        force: true,
      });
    }
    this.loginErrors.delete(loginErrorKey(profileId, target));
    if (target === "codex") this.onCodexAuthChanged();
  }

  async startBridge(input: { profileId: CodexProfileId; proxyBinaryPath: string }): Promise<void> {
    const existing = this.bridges.get(input.profileId);
    if (existing?.status === "running" || existing?.status === "starting") return;
    if (existing) await this.stopBridge(input.profileId);
    if (!(await this.isSignedIn(input.profileId, "claude-code"))) {
      throw new Error("Sign in to the Claude Code bridge for this account first.");
    }
    const proxyConfigDir = this.proxyConfigDir(input.profileId);
    const stateDir = path.join(proxyConfigDir, "state");
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const port = await reserveLoopbackPort();
    const configuredBinary = input.proxyBinaryPath || "claude-code-proxy";
    const binary = resolveExecutable(configuredBinary, { env: process.env });
    if (!binary) {
      throw new Error(`Claude Code proxy binary '${configuredBinary}' was not found.`);
    }
    const bridgeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CCP_CONFIG_DIR: proxyConfigDir,
      XDG_STATE_HOME: stateDir,
      CCP_BIND_ADDRESS: "127.0.0.1",
      CCP_CODEX_TRANSPORT: "http",
      CCP_CODEX_SERVER_COMPACTION: "1",
    };
    delete bridgeEnv.OPENAI_API_KEY;
    const child = spawn(binary, ["serve", "--port", String(port), "--no-monitor"], {
      env: bridgeEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    const bridge: BridgeProcess = { child, port, status: "starting" };
    this.bridges.set(input.profileId, bridge);
    let output = "";
    const capture = (chunk: Buffer | string) => {
      output = appendBounded(output, String(chunk));
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      bridge.status = "error";
      bridge.detail = safeProcessDetail(error.message, "Bridge failed to start.");
    });
    child.once("close", (code) => {
      if (this.bridges.get(input.profileId)?.child !== child) return;
      bridge.status = "error";
      bridge.detail = safeProcessDetail(output, `Bridge exited with code ${code ?? "unknown"}.`);
    });

    const deadline = Date.now() + BRIDGE_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (bridge.status === "error") throw new Error(bridge.detail ?? "Bridge failed to start.");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          bridge.status = "running";
          return;
        }
      } catch {
        // The listener may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.stopBridge(input.profileId);
    throw new Error(safeProcessDetail(output, "Timed out waiting for the Claude Code bridge."));
  }

  async stopBridge(profileId: CodexProfileId): Promise<void> {
    const bridge = this.bridges.get(profileId);
    if (!bridge) return;
    this.bridges.delete(profileId);
    await waitForExit(bridge.child);
  }

  async close(): Promise<void> {
    await Promise.all([
      ...[...this.logins.keys()].map((profileId) => this.cancelLogin(profileId)),
      ...[...this.bridges.keys()].map((profileId) => this.stopBridge(profileId)),
    ]);
  }

  async closeProfile(profileId: CodexProfileId): Promise<void> {
    await Promise.all([this.cancelLogin(profileId), this.stopBridge(profileId)]);
    this.loginErrors.delete(loginErrorKey(profileId, "codex"));
    this.loginErrors.delete(loginErrorKey(profileId, "claude-code"));
  }

  private launchCommand(port: number): string {
    return `env ANTHROPIC_BASE_URL=http://127.0.0.1:${port} ANTHROPIC_AUTH_TOKEN=unused 'ANTHROPIC_MODEL=gpt-5.6-sol[1m]' 'ANTHROPIC_SMALL_FAST_MODEL=gpt-5.6-luna[1m]' CLAUDE_CODE_AUTO_COMPACT_WINDOW=272000 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1 claude`;
  }
}
