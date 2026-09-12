import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { adminAddress } from "./admin.mjs";
import { discoverRuntimeUpstream, createUpstreamResolver } from "./desktop-upstream.mjs";
import { windowsTaskScript } from "./windows-service.mjs";

test("Windows admin pipe is stable across path casing and isolated per home", () => {
  const first = adminAddress("C:\\Users\\Alice Smith\\.synara-mobile", "win32");
  assert.ok(first.startsWith("\\\\.\\pipe\\synara-mobile-"));
  assert.equal(first, adminAddress("c:\\users\\alice smith\\.synara-mobile", "win32"));
  assert.notEqual(first, adminAddress("C:\\Users\\Bob\\.synara-mobile", "win32"));
});

test("runtime discovery proves the live endpoint and follows credentials after a restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "synara-mobile-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = join(directory, "userdata");
  mkdirSync(data, { mode: 0o700 });
  const state = { version: 1, pid: process.pid, port: 4567, origin: "http://127.0.0.1:4567",
    desktopAuthToken: "a".repeat(48), externalMcpRuntimeSecret: "s".repeat(48) };
  const save = () => writeFileSync(join(data, "server-runtime.json"), JSON.stringify(state), { mode: 0o600 });
  save();
  const fetchImpl = async (url, options) => {
    assert.equal(url.pathname, "/api/mcp/external/runtime-challenge");
    assert.equal(url.search, "");
    assert.ok(!JSON.stringify(options).includes(state.desktopAuthToken));
    const proof = createHmac("sha256", state.externalMcpRuntimeSecret)
      .update("synara.external-mcp.runtime\0").update(options.headers["x-synara-runtime-challenge"]).digest("base64url");
    return { ok: true, json: async () => ({ proof }) };
  };
  const discover = () => discoverRuntimeUpstream({ desktopHome: directory, fetchImpl });
  const resolver = createUpstreamResolver({ discover });
  assert.equal((await resolver.resolve()).token, "a".repeat(48));
  state.desktopAuthToken = "b".repeat(48);
  save();
  resolver.invalidate();
  assert.equal((await resolver.resolve()).token, "b".repeat(48));
  state.origin = "http://localhost:4567";
  save();
  assert.equal((await discover()).origin, "http://localhost:4567");
  state.origin = "http://127.0.0.1:4567";
  save();
  await assert.rejects(discoverRuntimeUpstream({ desktopHome: directory,
    fetchImpl: async () => ({ ok: true, json: async () => ({ proof: "x".repeat(43) }) }) }), /Cannot verify/);
  state.origin = "http://example.com:4567";
  save();
  await assert.rejects(discover(), /loopback/);
  state.origin = "http://127.0.0.1:4567";
  delete state.desktopAuthToken;
  save();
  await assert.rejects(discover(), /updated Synara/);
  state.desktopAuthToken = "b".repeat(48);
  save();
  renameSync(data, join(directory, "dev"));
  assert.equal((await discover()).token, state.desktopAuthToken);
  mkdirSync(data, { mode: 0o700 });
  save();
  await assert.rejects(discover(), /Multiple Synara/);
});

test("failed asynchronous discovery is retried instead of caching rejection", async () => {
  let calls = 0;
  const resolver = createUpstreamResolver({ discover: async () => {
    if (++calls === 1) throw new Error("offline");
    return { origin: "http://127.0.0.1:4567" };
  } });
  await assert.rejects(resolver.resolve(), /offline/);
  assert.equal((await resolver.resolve()).origin, "http://127.0.0.1:4567");
});

test("Windows login task checks ownership, stays unprivileged and never starts a backend", () => {
  const script = windowsTaskScript("install");
  assert.match(script, /Actions/);
  assert.match(script, /WorkingDirectory/);
  assert.match(script, /LogonType Interactive -RunLevel Limited/);
  assert.match(script, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(script, /RestartCount 3/);
  assert.doesNotMatch(script, /apps\/server|Stop-Process|taskkill/);
  assert.throws(() => windowsTaskScript("oops"));
});
