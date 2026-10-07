import { describe, expect, it } from "vitest";
import type { ServerProviderStatus } from "@synara/contracts";

import type { ResolvedProviderInstance } from "@synara/shared/providerInstances";

import { listDriverAccounts, pickDriverStatus } from "./targetResolver.ts";

const status = (instanceId: string, available: boolean) =>
  ({
    provider: "codex",
    driver: "codex",
    instanceId,
    available,
  }) as unknown as ServerProviderStatus;

describe("pickDriverStatus", () => {
  it("ignores a stale disabled instance listed after the default one", () => {
    const picked = pickDriverStatus([status("codex", true), status("codex_work", false)], "codex");
    expect(picked?.instanceId).toBe("codex");
  });
  it("falls back to an available account when the default is missing", () => {
    const picked = pickDriverStatus([status("codex_a", false), status("codex_b", true)], "codex");
    expect(picked?.instanceId).toBe("codex_b");
  });
});

describe("listDriverAccounts", () => {
  it("lists only enabled instances of the driver with their own status", () => {
    const instances = [
      { instanceId: "codex", driver: "codex", displayName: "Work", enabled: true, isDefault: true },
      {
        instanceId: "codex_personal",
        driver: "codex",
        displayName: "Personal",
        enabled: true,
        isDefault: false,
      },
      {
        instanceId: "codex_old",
        driver: "codex",
        displayName: "Old",
        enabled: false,
        isDefault: false,
      },
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        isDefault: true,
      },
    ] as unknown as ReadonlyArray<ResolvedProviderInstance>;
    const accounts = listDriverAccounts(instances, [status("codex_personal", true)], "codex");
    expect(accounts.map((account) => account.instanceId)).toEqual(["codex", "codex_personal"]);
    expect(accounts[1]?.available).toBe(true);
    expect(accounts[0]?.available).toBeUndefined();
  });
});
