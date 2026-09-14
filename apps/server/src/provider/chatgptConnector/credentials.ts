// FILE: credentials.ts
// Purpose: Owns the secret path token that authorizes ChatGPT's MCP traffic
//          into this Synara server.
// Layer: Server provider connector (security boundary)
//
// ChatGPT's developer-mode connector cannot present a Synara session cookie or
// bearer token, so the credential is an unguessable 256-bit path segment,
// exactly like the reference implementation this provider is modeled on. The
// token is persisted per Synara home so a configured connector keeps working
// across restarts; rotation is explicit.

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

export const CHATGPT_CONNECTOR_SECRET_FILENAME = "chatgpt-connector.json";
export const CHATGPT_CONNECTOR_PATH_PREFIX = "/mcp/chatgpt";

/** 32 random bytes encoded as base64url are 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface ChatGptConnectorSecret {
  readonly token: string;
  readonly createdAt: string;
}

export function isValidConnectorToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function generateConnectorToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time comparison for tokens already validated by shape. */
export function connectorTokensMatch(expected: string, candidate: string): boolean {
  if (!isValidConnectorToken(expected) || !isValidConnectorToken(candidate)) return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(candidate, "utf8");
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

export function connectorPathForToken(token: string): string {
  return `${CHATGPT_CONNECTOR_PATH_PREFIX}/${token}`;
}

/**
 * Loopback form of a configured listen host: wildcard and IPv6 wildcard binds
 * are advertised as 127.0.0.1 because the connector target is always local.
 */
export function loopbackHostForUrl(host: string): string {
  const normalized = host.trim();
  if (normalized === "" || normalized === "0.0.0.0" || normalized === "::" || normalized === "*") {
    return "127.0.0.1";
  }
  if (normalized === "::1") return "[::1]";
  return normalized;
}

export function connectorLocalUrl(input: {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}): string {
  return `http://${loopbackHostForUrl(input.host)}:${input.port}${connectorPathForToken(input.token)}`;
}

export function connectorPublicUrl(input: {
  readonly publicOrigin: string;
  readonly token: string;
}): string {
  return `${input.publicOrigin.replace(/\/+$/u, "")}${connectorPathForToken(input.token)}`;
}

const secretPath = (stateDir: string): string =>
  Path.join(stateDir, CHATGPT_CONNECTOR_SECRET_FILENAME);

function decodeSecret(raw: string): ChatGptConnectorSecret | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const token = typeof record.token === "string" ? record.token : "";
    if (!isValidConnectorToken(token)) return null;
    const createdAt =
      typeof record.createdAt === "string" && record.createdAt.length > 0
        ? record.createdAt
        : new Date(0).toISOString();
    return { token, createdAt };
  } catch {
    return null;
  }
}

async function writeSecret(stateDir: string, secret: ChatGptConnectorSecret): Promise<void> {
  await FS.mkdir(stateDir, { recursive: true });
  const target = secretPath(stateDir);
  const temp = `${target}.tmp-${process.pid}`;
  await FS.writeFile(temp, `${JSON.stringify(secret, null, 2)}\n`, { mode: 0o600 });
  await FS.rename(temp, target);
  // Older installs may carry wider permissions from a previous umask.
  await FS.chmod(target, 0o600).catch(() => undefined);
}

export function makeConnectorSecret(): ChatGptConnectorSecret {
  return { token: generateConnectorToken(), createdAt: new Date().toISOString() };
}

/**
 * Loads the persisted connector token, creating (and persisting) one on first
 * use. A corrupt file is replaced rather than reused: holding an unreadable
 * credential would silently break every ChatGPT tool call.
 */
export async function loadOrCreateConnectorSecret(
  stateDir: string,
): Promise<ChatGptConnectorSecret> {
  try {
    const raw = await FS.readFile(secretPath(stateDir), "utf8");
    const decoded = decodeSecret(raw);
    if (decoded) return decoded;
  } catch {
    // Missing or unreadable: fall through to creating a new secret.
  }
  const secret = makeConnectorSecret();
  await writeSecret(stateDir, secret);
  return secret;
}

export async function rotateConnectorSecret(stateDir: string): Promise<ChatGptConnectorSecret> {
  const secret = makeConnectorSecret();
  await writeSecret(stateDir, secret);
  return secret;
}
