import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { adminAddress } from "./admin.mjs";
import { discoverRuntimeUpstream, createUpstreamResolver } from "./desktop-upstream.mjs";
import { windowsTaskScript } from "./windows-service.mjs";
import { createPrivateFixtureDirectory } from "./test-private-directory.mjs";
import * as windows from "./windows.mjs";

test("Windows admin pipe is stable across path casing and isolated per home", () => {
  const first = adminAddress("C:\\Users\\Alice Smith\\.synara-mobile", "win32");
  assert.ok(first.startsWith("\\\\.\\pipe\\synara-mobile-"));
  assert.equal(first, adminAddress("c:\\users\\alice smith\\.synara-mobile", "win32"));
  assert.notEqual(first, adminAddress("C:\\Users\\Bob\\.synara-mobile", "win32"));
});

test("runtime discovery proves the live endpoint and follows credentials after a restart", async (t) => {
  const directory = createPrivateFixtureDirectory("synara-mobile-runtime-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = join(directory, "userdata");
  mkdirSync(data, { mode: 0o700 });
  const state = {
    version: 1,
    pid: process.pid,
    port: 4567,
    origin: "http://127.0.0.1:4567",
    desktopAuthToken: "a".repeat(48),
    externalMcpRuntimeSecret: "s".repeat(48),
  };
  const save = () =>
    writeFileSync(join(data, "server-runtime.json"), JSON.stringify(state), { mode: 0o600 });
  save();
  const fetchImpl = async (url, options) => {
    assert.equal(url.pathname, "/api/mcp/external/runtime-challenge");
    assert.equal(url.search, "");
    assert.ok(!JSON.stringify(options).includes(state.desktopAuthToken));
    const proof = createHmac("sha256", state.externalMcpRuntimeSecret)
      .update("synara.external-mcp.runtime\0")
      .update(options.headers["x-synara-runtime-challenge"])
      .digest("base64url");
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
  await assert.rejects(
    discoverRuntimeUpstream({
      desktopHome: directory,
      fetchImpl: async () => ({ ok: true, json: async () => ({ proof: "x".repeat(43) }) }),
    }),
    /Cannot verify/,
  );
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
  const resolver = createUpstreamResolver({
    discover: async () => {
      if (++calls === 1) throw new Error("offline");
      return { origin: "http://127.0.0.1:4567" };
    },
  });
  await assert.rejects(resolver.resolve(), /offline/);
  assert.equal((await resolver.resolve()).origin, "http://127.0.0.1:4567");
});

test("runtime waits for asynchronous ACL validation while status requests keep responding", async (t) => {
  const directory = createPrivateFixtureDirectory("synara-mobile-acl-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = join(directory, "userdata");
  const path = join(data, "server-runtime.json");
  mkdirSync(data, { mode: 0o700 });
  const state = {
    version: 1,
    pid: process.pid,
    port: 4567,
    origin: "http://127.0.0.1:4567",
    desktopAuthToken: "a".repeat(48),
    externalMcpRuntimeSecret: "s".repeat(48),
  };
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  const validated = [];
  const gate = Promise.withResolvers();
  let proofRequests = 0;
  const options = {
    desktopHome: directory,
    platform: "win32",
    assertPrivatePaths: async (paths) => {
      validated.push(paths);
      await gate.promise;
    },
    fetchImpl: async (_url, request) => {
      proofRequests++;
      const proof = createHmac("sha256", state.externalMcpRuntimeSecret)
        .update("synara.external-mcp.runtime\0")
        .update(request.headers["x-synara-runtime-challenge"])
        .digest("base64url");
      return { ok: true, json: async () => ({ proof }) };
    },
  };
  const statusServer = http.createServer((_req, res) => res.end('{"paired":false}'));
  statusServer.listen(0, "127.0.0.1");
  await once(statusServer, "listening");
  t.after(() => {
    statusServer.closeAllConnections();
    statusServer.close();
    gate.resolve();
  });
  const pending = discoverRuntimeUpstream(options);
  assert.deepEqual(validated, [[data, path]], "validate the directory and file before reading");
  const status = await fetch(`http://127.0.0.1:${statusServer.address().port}/mobile/api/status`, {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(status.status, 200);
  await status.json();
  assert.equal(proofRequests, 0, "credentials cannot be used before the ACL check succeeds");
  gate.resolve();
  assert.equal((await pending).token, state.desktopAuthToken);

  // A denied ACL must win over even an unreadable credential file.
  writeFileSync(path, "invalid json", { mode: 0o600 });
  await assert.rejects(
    discoverRuntimeUpstream({
      ...options,
      assertPrivatePaths: async () => {
        throw new Error("ACL denied");
      },
    }),
    /ACL denied/,
  );
  assert.equal(proofRequests, 1);

  // A replacement during an asynchronous check must be validated on a later attempt.
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(
    discoverRuntimeUpstream({
      ...options,
      assertPrivatePaths: async () => {
        renameSync(path, path + ".old");
        writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
      },
    }),
    /runtime path changed/,
  );
  assert.equal(proofRequests, 1);
});

test("Windows ACL batch uses one bounded asynchronous process and preserves strict checks", async () => {
  const paths = ["C:\\Users\\Alice Smith\\.synara\\userdata", "C:\\literal'$()\\state.json"];
  let complete;
  let calls = 0;
  const pending = windows.assertPrivateWindowsPaths(paths, (command, args, options, done) => {
    calls++;
    assert.equal(command, "powershell.exe");
    assert.equal(options.timeout, 10_000);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(JSON.parse(options.env.SYNARA_MOBILE_PRIVATE_PATHS), paths);
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    for (const guard of [
      "-LiteralPath",
      "ReparsePoint",
      "GetOwner",
      "DiscretionaryAcl",
      "GetAccessRules",
    ])
      assert.ok(script.includes(guard), guard);
    assert.ok(script.includes("S-1-5-18"));
    assert.ok(script.includes("S-1-5-32-544"));
    assert.ok(script.includes("$privatePaths = ConvertFrom-Json"));
    assert.ok(script.includes("foreach ($privatePath in $privatePaths)"));
    assert.ok(script.includes("$privatePath -isnot [string]"));
    assert.ok(!script.includes("@(ConvertFrom-Json"));
    assert.ok(!script.includes(paths[1]), "path values must never become PowerShell code");
    complete = done;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  complete(null, "");
  await pending;
  const timeout = Object.assign(new Error("ACL process timed out"), { code: "ETIMEDOUT" });
  await assert.rejects(
    windows.assertPrivateWindowsPaths(paths, (_command, _args, _options, done) => done(timeout)),
    (error) => error === timeout,
  );
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
