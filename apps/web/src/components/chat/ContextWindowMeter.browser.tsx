// Verify the actual tooltip keeps the applied mode separate from runtime usage.
import { EventId, type OrchestrationThreadActivity } from "@synara/contracts";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  deriveAppliedContextWindowSelection,
  deriveContextWindowSelectionStatus,
  deriveLatestContextWindowState,
} from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

it("shows Auto as applied with the 967k runtime threshold and no pending Auto", async () => {
  const activities: OrchestrationThreadActivity[] = [
    {
      id: EventId.makeUnsafe("config"),
      kind: "context-window.configured",
      tone: "info",
      summary: "Auto",
      payload: { cleared: true },
      turnId: null,
      createdAt: "2026-09-17T00:00:00Z",
    },
    {
      id: EventId.makeUnsafe("usage"),
      kind: "context-window.updated",
      tone: "info",
      summary: "Usage",
      payload: { usedTokens: 500_000, maxTokens: 967_000, usedPercent: 51.7 },
      turnId: null,
      createdAt: "2026-09-17T00:00:01Z",
    },
  ];
  const usage = deriveLatestContextWindowState(activities).snapshot!;
  const status = deriveContextWindowSelectionStatus({
    activeSnapshot: usage,
    selectedValue: "auto",
    appliedValue: deriveAppliedContextWindowSelection(activities),
  });
  await render(
    <ContextWindowMeter
      usage={usage}
      showClaudeCache
      activeWindowLabel={status.activeLabel}
      pendingWindowLabel={status.pendingSelectedLabel}
    />,
  );
  await page.getByRole("button", { name: "Context window 52% used" }).click();
  await expect.element(page.getByText("Auto-compact target: Auto")).toBeVisible();
  await expect.element(page.getByText("Active context limit: 967k tokens")).toBeVisible();
  await expect.element(page.getByText("Next turn:", { exact: false })).not.toBeInTheDocument();
});

it("shows observed Codex cache reads for the last request and session", async () => {
  const usage = deriveLatestContextWindowState([
    {
      id: EventId.makeUnsafe("codex-usage"),
      kind: "context-window.updated",
      tone: "info",
      summary: "Usage",
      payload: {
        provider: "codex",
        usedTokens: 193_000,
        maxTokens: 258_000,
        lastInputTokens: 192_000,
        lastCachedInputTokens: 96_000,
        lastCacheCreationInputTokens: 40_000,
        cumulativeUsage: {
          inputTokens: 2_400_000,
          outputTokens: 120_000,
          cachedInputTokens: 1_200_000,
          cacheCreationInputTokens: 400_000,
        },
      },
      turnId: null,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    },
  ]).snapshot!;

  await render(<ContextWindowMeter usage={usage} showCodexCache />);
  await page.getByRole("button", { name: "Context window 75% used" }).click();
  await expect.element(page.getByText("Codex prompt cache")).toBeVisible();
  await expect.element(page.getByText("Cache status: Recently observed")).toBeVisible();
  await expect
    .element(page.getByText("Last confirmed cache activity:", { exact: false }))
    .toBeVisible();
  await expect.element(page.getByText("Last request · read")).toBeVisible();
  await expect.element(page.getByText("96k tokens · 50% of input")).toBeVisible();
  await expect.element(page.getByText("Last request · written")).toBeVisible();
  await expect.element(page.getByText("40k tokens")).toBeVisible();
  await expect.element(page.getByText("Session · read")).toBeVisible();
  await expect.element(page.getByText("1.2m tokens · 50% of input")).toBeVisible();
  await expect.element(page.getByText("Session · written")).toBeVisible();
  await expect.element(page.getByText("400k tokens")).toBeVisible();
});

it("shows a reported zero cache read without inventing missing write counts", async () => {
  const usage = deriveLatestContextWindowState([
    {
      id: EventId.makeUnsafe("codex-cache-zero"),
      kind: "context-window.updated",
      tone: "info",
      summary: "Usage",
      payload: {
        provider: "codex",
        usedTokens: 10_000,
        maxTokens: 100_000,
        lastInputTokens: 8_000,
        lastCachedInputTokens: 0,
      },
      turnId: null,
      createdAt: "2026-09-17T00:00:00Z",
    },
  ]).snapshot!;

  await render(<ContextWindowMeter usage={usage} showCodexCache />);
  await page.getByRole("button", { name: "Context window 10% used" }).click();
  await expect.element(page.getByText("Last request · read")).toBeVisible();
  await expect.element(page.getByText("0 tokens · 0% of input")).toBeVisible();
  await expect.element(page.getByText("Last request · written")).not.toBeInTheDocument();
});
