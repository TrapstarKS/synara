// FILE: credentials.test.ts
// Purpose: Unit tests for the ChatGPT connector path-token credential store:
//          token shape, constant-time matching, persistence, corruption
//          replacement, rotation and loopback/public URL shaping.
// Layer: Server provider connector tests

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CHATGPT_CONNECTOR_PATH_PREFIX,
  CHATGPT_CONNECTOR_SECRET_FILENAME,
  connectorLocalUrl,
  connectorPathForToken,
  connectorPublicUrl,
  connectorTokensMatch,
  generateConnectorToken,
  isValidConnectorToken,
  loadOrCreateConnectorSecret,
  rotateConnectorSecret,
} from "./credentials.ts";

const temporaryDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synara-chatgpt-credentials-"));
  temporaryDirs.push(dir);
  return dir;
}

const secretFile = (dir: string): string => path.join(dir, CHATGPT_CONNECTOR_SECRET_FILENAME);

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const TOKEN = "A".repeat(43);

describe("connector token shape", () => {
  it("generates 43-character base64url tokens that validate", () => {
    for (let index = 0; index < 8; index += 1) {
      const token = generateConnectorToken();
      expect(token).toHaveLength(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(isValidConnectorToken(token)).toBe(true);
    }
  });

  it("rejects short, long, and illegal tokens", () => {
    expect(isValidConnectorToken("")).toBe(false);
    expect(isValidConnectorToken("A".repeat(42))).toBe(false);
    expect(isValidConnectorToken("A".repeat(44))).toBe(false);
    expect(isValidConnectorToken(`${"A".repeat(42)}+`)).toBe(false);
    expect(isValidConnectorToken(`${"A".repeat(42)}/`)).toBe(false);
    expect(isValidConnectorToken(`${"A".repeat(42)}=`)).toBe(false);
    expect(isValidConnectorToken(`${"A".repeat(42)}.`)).toBe(false);
    expect(isValidConnectorToken("   ")).toBe(false);
  });

  it("matches only equal, well-formed tokens", () => {
    const token = generateConnectorToken();
    expect(connectorTokensMatch(token, token)).toBe(true);
    expect(connectorTokensMatch(TOKEN, "B".repeat(43))).toBe(false);
    expect(connectorTokensMatch(TOKEN, "short")).toBe(false);
    expect(connectorTokensMatch("short", "short")).toBe(false);
    expect(connectorTokensMatch("", "")).toBe(false);
  });

  it("preserves the token path segment", () => {
    expect(connectorPathForToken(TOKEN)).toBe(`${CHATGPT_CONNECTOR_PATH_PREFIX}/${TOKEN}`);
  });
});

describe("loadOrCreateConnectorSecret", () => {
  it("creates the secret file and reuses the same token", async () => {
    const dir = await tempDir();

    const first = await loadOrCreateConnectorSecret(dir);
    expect(isValidConnectorToken(first.token)).toBe(true);
    const created = await stat(secretFile(dir));
    expect(created.isFile()).toBe(true);

    const second = await loadOrCreateConnectorSecret(dir);
    expect(second).toEqual(first);
  });

  it.skipIf(process.platform === "win32")("writes the secret owner-only (0600)", async () => {
    const dir = await tempDir();
    await loadOrCreateConnectorSecret(dir);

    const created = await stat(secretFile(dir));
    expect(created.mode & 0o777).toBe(0o600);
  });

  it("replaces corrupt file content with a new valid token", async () => {
    const dir = await tempDir();
    const original = await loadOrCreateConnectorSecret(dir);

    await writeFile(secretFile(dir), "{ not json", "utf8");
    const replacement = await loadOrCreateConnectorSecret(dir);

    expect(replacement.token).not.toBe(original.token);
    expect(isValidConnectorToken(replacement.token)).toBe(true);

    const persisted = JSON.parse(await readFile(secretFile(dir), "utf8")) as Record<
      string,
      unknown
    >;
    expect(persisted.token).toBe(replacement.token);
    expect(typeof persisted.createdAt).toBe("string");
  });

  it("replaces a structurally invalid token even when the JSON parses", async () => {
    const dir = await tempDir();
    await writeFile(secretFile(dir), JSON.stringify({ token: "too-short" }), "utf8");

    const replacement = await loadOrCreateConnectorSecret(dir);
    expect(isValidConnectorToken(replacement.token)).toBe(true);

    const persisted = JSON.parse(await readFile(secretFile(dir), "utf8")) as Record<
      string,
      unknown
    >;
    expect(persisted.token).toBe(replacement.token);
  });
});

describe("rotateConnectorSecret", () => {
  it("returns a different token and persists it", async () => {
    const dir = await tempDir();
    const original = await loadOrCreateConnectorSecret(dir);

    const rotated = await rotateConnectorSecret(dir);

    expect(rotated.token).not.toBe(original.token);
    expect(isValidConnectorToken(rotated.token)).toBe(true);
    await expect(loadOrCreateConnectorSecret(dir)).resolves.toEqual(rotated);
  });
});

describe("connector URLs", () => {
  const pathSuffix = connectorPathForToken(TOKEN);

  it("maps wildcard hosts to 127.0.0.1 and preserves the token path", () => {
    for (const host of ["0.0.0.0", "::", "*", "", "   "]) {
      expect(connectorLocalUrl({ host, port: 58090, token: TOKEN })).toBe(
        `http://127.0.0.1:58090${pathSuffix}`,
      );
    }
  });

  it("keeps ::1 bracketed and passes concrete hosts through", () => {
    expect(connectorLocalUrl({ host: "::1", port: 58090, token: TOKEN })).toBe(
      `http://[::1]:58090${pathSuffix}`,
    );
    expect(connectorLocalUrl({ host: "  localhost  ", port: 58090, token: TOKEN })).toBe(
      `http://localhost:58090${pathSuffix}`,
    );
    expect(connectorLocalUrl({ host: "192.168.1.20", port: 58090, token: TOKEN })).toBe(
      `http://192.168.1.20:58090${pathSuffix}`,
    );
  });

  it("strips trailing slashes from the public origin", () => {
    expect(connectorPublicUrl({ publicOrigin: "https://abc.example", token: TOKEN })).toBe(
      `https://abc.example${pathSuffix}`,
    );
    expect(connectorPublicUrl({ publicOrigin: "https://abc.example/", token: TOKEN })).toBe(
      `https://abc.example${pathSuffix}`,
    );
    expect(connectorPublicUrl({ publicOrigin: "https://abc.example///", token: TOKEN })).toBe(
      `https://abc.example${pathSuffix}`,
    );
  });
});
