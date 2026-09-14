import { describe, expect, it } from "vitest";

import {
  WsAutomationCreateRpc,
  WsAutomationGetMemoryRpc,
  WsAutomationResolveProposalRpc,
  WsBootstrapRpcGroup,
  WsDeviceRpcGroup,
  WsFeatureRpcGroup,
  WsProjectsDiscoverScriptsRpc,
  WsProjectsProvisionFromGitHubRpc,
  WsProjectsSubscribeFileChangeRpc,
  WsPullRequestsReviewRequestCountRpc,
  WsRpcError,
} from "./rpc";
import { ORCHESTRATION_WS_METHODS } from "./orchestration";
import { WS_METHODS } from "./ws";

describe("WS RPC contracts", () => {
  it("keeps bootstrap and feature RPCs in separate groups", () => {
    expect(WsBootstrapRpcGroup.requests.has("bootstrap.negotiate")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("bootstrap.negotiate")).toBe(false);
    expect(
      WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers),
    ).toBe(true);
    expect(WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.reconcileProviderDelivery)).toBe(
      true,
    );
  });

  it("uses a schema-backed transport error", () => {
    expect(new WsRpcError({ message: "failed" }).message).toBe("failed");
  });

  it("exports the project script discovery RPC", () => {
    expect(WsProjectsDiscoverScriptsRpc).toBeDefined();
    expect(WsProjectsProvisionFromGitHubRpc).toBeDefined();
    expect(WsProjectsSubscribeFileChangeRpc).toBeDefined();
    expect(WsFeatureRpcGroup.requests.has("projects.provisionFromGitHub")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("projects.subscribeFileChange")).toBe(true);
  });

  it("exports the automation create RPC", () => {
    expect(WsAutomationCreateRpc).toBeDefined();
    expect(WsAutomationGetMemoryRpc).toBeDefined();
    expect(WsAutomationResolveProposalRpc).toBeDefined();
  });

  it("exports the count-only pull request review RPC", () => {
    expect(WsPullRequestsReviewRequestCountRpc).toBeDefined();
  });

  it("registers an RPC group entry for every WS method", () => {
    // The server builds its request handlers from the feature group; a handler
    // whose method has no group entry crashes handler construction at runtime
    // (RpcGroup reads `.key` from a missing request), which unit tests on the
    // source layer never observe. This pins the invariant here.
    const registered = new Set<string>([
      ...WsBootstrapRpcGroup.requests.keys(),
      ...WsFeatureRpcGroup.requests.keys(),
      ...WsDeviceRpcGroup.requests.keys(),
    ]);
    const missing = Object.entries(WS_METHODS)
      .filter(([, method]) => !registered.has(method))
      .map(([name, method]) => `${name} (${method})`);

    expect(missing).toEqual([]);
  });
});
