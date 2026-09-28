import { describe, expect, it } from "vitest";
import {
  getModelCapabilities,
  normalizeClaudeModelOptions,
  resolveApiModelId,
} from "@synara/shared/model";
import {
  resolveSelectedClaudeAutoCompactWindow,
  resolveClaudeApiModelIdContextWindowMaxTokens,
} from "./claudeTokenUsage";

describe("Claude explicit compact overrides", () => {
  it.each(["claude-opus-4-6", "claude-sonnet-4-6", "claude-fable-5-1", "claude-sonnet-5"])(
    "defaults %s to 200k and keeps explicit 1M and auto",
    (model) => {
      expect(normalizeClaudeModelOptions(model, { autoCompactWindow: "200k" })).toBeUndefined();
      expect(resolveSelectedClaudeAutoCompactWindow(model, undefined)).toBe(200_000);
      const oneM = normalizeClaudeModelOptions(model, { autoCompactWindow: "1m" });
      expect(oneM?.autoCompactWindow).toBe("1m");
      expect(resolveSelectedClaudeAutoCompactWindow(model, oneM?.autoCompactWindow)).toBe(
        1_000_000,
      );
      const auto = normalizeClaudeModelOptions(model, { autoCompactWindow: "auto" });
      expect(auto?.autoCompactWindow).toBe("auto");
      expect(resolveSelectedClaudeAutoCompactWindow(model, "auto")).toBeUndefined();
      expect(getModelCapabilities("claudeAgent", model).contextWindowTokens).toBe(1_000_000);
    },
  );
  it.each(["claude-opus-4-6", "claude-sonnet-4-6"])(
    "opts %s into extended context when 1M is requested",
    (model) => {
      const apiId = resolveApiModelId({
        provider: "claudeAgent",
        model,
        options: { autoCompactWindow: "1m" },
      });
      expect(apiId).toBe(`${model}[1m]`);
      expect(resolveClaudeApiModelIdContextWindowMaxTokens(apiId)).toBe(1_000_000);
    },
  );
});
