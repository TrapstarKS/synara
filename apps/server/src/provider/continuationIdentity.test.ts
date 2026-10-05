// FILE: continuationIdentity.test.ts
// Purpose: Verifies provider-native storage identities across account path spellings.
// Layer: Server provider utility tests.

import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

import {
  parseCodexSharedContinuationIdentity,
  providerContinuationIdentity,
} from "./continuationIdentity.ts";

describe("providerContinuationIdentity", () => {
  it("parses v2 identities without splitting Windows drive-letter colons", () => {
    assert.deepEqual(
      parseCodexSharedContinuationIdentity(
        String.raw`codex:shared-v2:123e4567-e89b-42d3-a456-426614174000:C:\Users\Ada\.codex`,
      ),
      {
        version: 2,
        generation: "123e4567-e89b-42d3-a456-426614174000",
        sourceIdentity: String.raw`C:\Users\Ada\.codex`,
      },
    );
  });

  it("treats Windows and Unix tilde separators as the same Claude home", () => {
    const windowsSpelling = providerContinuationIdentity("claudeAgent", {
      claudeAgent: { homePath: "~\\.claude-work" },
    });
    const unixSpelling = providerContinuationIdentity("claudeAgent", {
      claudeAgent: { homePath: "~/.claude-work" },
    });
    const absoluteSpelling = providerContinuationIdentity("claudeAgent", {
      claudeAgent: { homePath: path.join(homedir(), ".claude-work") },
    });

    assert.equal(windowsSpelling, unixSpelling);
    assert.equal(windowsSpelling, absoluteSpelling);
  });

  it("binds Codex continuation to the native account home", () => {
    const identity = (homePath: string) =>
      providerContinuationIdentity("codex", { codex: { homePath } } as never);
    assert.equal(identity("/codex-test/.codex"), identity("/codex-test/.codex"));
    assert.notEqual(identity("/codex-test/.codex"), identity("/codex-test/.codex-work"));
    assert.match(identity("/codex-test/.codex") ?? "", /^codex:native-v1:/);
  });
});
