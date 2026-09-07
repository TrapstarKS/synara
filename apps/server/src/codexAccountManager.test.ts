import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { CodexProfileId } from "@synara/contracts";
import { CodexAccountManager } from "./codexAccountManager.ts";

const profileId = CodexProfileId.makeUnsafe("cc8a51b2-008c-429b-85ba-ed1fc28c0af1");
const temporaryDirectories: string[] = [];
const managers: CodexAccountManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((entry) => fs.rm(entry, { recursive: true })),
  );
});

async function makeFakeBinary(root: string): Promise<string> {
  const filePath = path.join(root, "fake-provider.mjs");
  await fs.writeFile(
    filePath,
    `#!/usr/bin/env node
import http from "node:http";
if (process.argv.includes("serve")) {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  http.createServer((request, response) => {
    response.writeHead(request.url === "/healthz" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: request.url === "/healthz" }));
  }).listen(port, "127.0.0.1");
} else {
  console.log("Visit: https://auth.openai.com/codex/device");
  console.log("Code: ABCD-12345");
  setInterval(() => {}, 1000);
}
`,
    { mode: 0o700 },
  );
  return filePath;
}

describe("CodexAccountManager", () => {
  it("returns a device code and cancels only its owned login process", async () => {
    const secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-account-manager-"));
    temporaryDirectories.push(secretsDir);
    const binaryPath = await makeFakeBinary(secretsDir);
    const manager = new CodexAccountManager(secretsDir);
    managers.push(manager);

    const state = await manager.startLogin({
      profileId,
      target: "codex",
      codexBinaryPath: binaryPath,
      proxyBinaryPath: binaryPath,
    });
    assert.equal(state.codexAuth, "signing-in");
    assert.equal(state.verificationUrl, "https://auth.openai.com/codex/device");
    assert.equal(state.userCode, "ABCD-12345");

    await manager.cancelLogin(profileId);
    const cancelled = await manager.getState({ profileId, proxyBinaryPath: binaryPath });
    assert.equal(cancelled.codexAuth, "signed-out");
  });

  it("keeps login failures scoped to the target that failed", async () => {
    const secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-account-manager-"));
    temporaryDirectories.push(secretsDir);
    const binaryPath = path.join(secretsDir, "failed-login.mjs");
    await fs.writeFile(
      binaryPath,
      '#!/usr/bin/env node\nconsole.error("device login failed Bearer secret-token");\n',
      { mode: 0o700 },
    );
    const manager = new CodexAccountManager(secretsDir);
    managers.push(manager);

    await assert.rejects(
      manager.startLogin({
        profileId,
        target: "codex",
        codexBinaryPath: binaryPath,
        proxyBinaryPath: binaryPath,
      }),
      /device login failed/,
    );
    const state = await manager.getState({ profileId, proxyBinaryPath: binaryPath });
    assert.equal(state.codexAuth, "error");
    assert.equal(state.claudeCodeAuth, "signed-out");
    assert.match(state.detail ?? "", /Bearer \[redacted\]/);
    assert.doesNotMatch(state.detail ?? "", /secret-token/);

    await manager.closeProfile(profileId);
    const cleared = await manager.getState({ profileId, proxyBinaryPath: binaryPath });
    assert.equal(cleared.detail, undefined);
  });

  it("starts a loopback bridge for proxy-owned credentials and returns a launch command", async () => {
    const secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-account-bridge-"));
    temporaryDirectories.push(secretsDir);
    const binaryPath = await makeFakeBinary(secretsDir);
    const authPath = path.join(
      secretsDir,
      "codex-profiles",
      profileId,
      "claude-code-proxy",
      "codex",
      "auth.json",
    );
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(authPath, '{"tokens":{"access_token":"redacted"}}');
    const manager = new CodexAccountManager(secretsDir);
    managers.push(manager);

    await manager.startBridge({ profileId, proxyBinaryPath: binaryPath });
    const state = await manager.getState({ profileId, proxyBinaryPath: binaryPath });
    assert.equal(state.bridgeStatus, "running");
    assert.match(state.launchCommand ?? "", /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:/);

    await manager.stopBridge(profileId);
    const stopped = await manager.getState({ profileId, proxyBinaryPath: binaryPath });
    assert.equal(stopped.bridgeStatus, "stopped");
  });
});
