import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  createUpstreamResolver,
  discoverDesktopUpstream,
  parseDesktopEnvironment,
  parseProcessTable,
} from "./desktop-upstream.mjs";

const executable = "/Applications/Synara.app/Contents/MacOS/Synara";
const home = "/Users/test/.synara";
const token = "a".repeat(48);
const table = `
  40     1 ${executable}
  41    40 ${executable} --max-old-space-size=6144 /Applications/Synara.app/Contents/Resources/app.asar/apps/server/dist/index.mjs
  42     1 ${executable} --max-old-space-size=6144 /tmp/apps/server/dist/index.mjs
`;

test("desktop discovery accepts only the server child owned by the installed app", () => {
  assert.deepEqual(
    parseProcessTable(table, executable).map((row) => row.pid),
    [41],
  );
  const environment = `${executable} server SYNARA_MODE=desktop SYNARA_PORT=56673 SYNARA_HOME=${home} SYNARA_AUTH_TOKEN=${token} PATH=/usr/bin`;
  assert.deepEqual(parseDesktopEnvironment(environment, home), { port: 56673, token });
  for (const changed of [
    environment.replace("SYNARA_MODE=desktop", "SYNARA_MODE=server"),
    environment.replace("SYNARA_PORT=56673", "SYNARA_PORT=80"),
    environment.replace(home, "/Users/test/other"),
    environment.replace(token, "short"),
  ])
    assert.equal(parseDesktopEnvironment(changed, home), null);
});

test("desktop discovery verifies that the candidate owns its advertised listener", () => {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, args]);
    if (command === "/bin/ps" && args.includes("-axo")) return table;
    if (command === "/bin/ps")
      return `${executable} server SYNARA_MODE=desktop SYNARA_PORT=56673 SYNARA_HOME=${home} SYNARA_AUTH_TOKEN=${token}`;
    if (command === "/usr/sbin/lsof") return "41\n";
    throw new Error("unexpected command");
  };
  assert.deepEqual(
    discoverDesktopUpstream({ desktopExecutable: executable, desktopHome: home, exec, platform: "darwin" }),
    {
      origin: "http://127.0.0.1:56673",
      token,
      scope: `desktop:${resolve(home)}`,
    },
  );
  assert.equal(
    calls.some(([command]) => command === "/usr/sbin/lsof"),
    true,
  );
  assert.throws(
    () =>
      discoverDesktopUpstream({
        desktopExecutable: executable,
        desktopHome: home,
        platform: "darwin",
        exec: (command, args) =>
          command === "/bin/ps" && args.includes("-axo")
            ? table
            : command === "/bin/ps"
              ? `${executable} SYNARA_MODE=desktop SYNARA_PORT=56673 SYNARA_HOME=${home} SYNARA_AUTH_TOKEN=${token}`
              : "99\n",
      }),
    /not running/,
  );
});

test("resolver caches discovery briefly, invalidates on failure and preserves fixed test targets", () => {
  let discoveries = 0,
    clock = 1;
  const resolver = createUpstreamResolver({
    discover: () => ({
      origin: `http://127.0.0.1:${5000 + ++discoveries}`,
      token,
      scope: home,
    }),
    cacheMs: 10,
    now: () => clock,
  });
  assert.equal(resolver.resolve().origin, "http://127.0.0.1:5001");
  assert.equal(resolver.resolve().origin, "http://127.0.0.1:5001");
  resolver.invalidate();
  assert.equal(resolver.resolve().origin, "http://127.0.0.1:5002");
  clock += 11;
  assert.equal(resolver.resolve().origin, "http://127.0.0.1:5003");

  const fixed = createUpstreamResolver({ upstream: "http://127.0.0.1:7777", token });
  assert.deepEqual(fixed.resolve(), {
    origin: "http://127.0.0.1:7777",
    token,
    scope: "http://127.0.0.1:7777",
  });
  assert.throws(() => createUpstreamResolver({ upstream: "https://example.com" }));
});
