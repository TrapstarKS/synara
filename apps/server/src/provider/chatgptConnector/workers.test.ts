// FILE: workers.test.ts
// Purpose: Unit tests for the ChatGPT connector worker broker: spawn slot
//          accounting and reuse, queued delivery while a worker generates,
//          finish attribution, inbox delivery, and status snapshots.
// Layer: Server provider connector tests
//
// The broker runs against fake callbacks and deferred worker turns only: a
// pending waitForWorkerTurn stands in for a live ChatGPT generation, and the
// test resolves it to drive the queue drain deterministically.

import { describe, expect, it, vi } from "vitest";

import type { McpToolCallResult } from "../../agentGateway/protocol.ts";
import type { ChatGptConversationRef } from "../chatgptWeb/types.ts";
import type { ConnectorCallContext } from "./runtime.ts";
import { ChatGptWorkerBroker, ChatGptWorkerRateLimitedError } from "./workers.ts";

const toolText = (result: McpToolCallResult): string => {
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
};

interface PendingTurn {
  readonly submittedText: string;
  readonly onGenerating: (generating: boolean) => void;
  readonly resolve: (answer: string) => void;
  readonly reject: (error: unknown) => void;
}

const createHarness = () => {
  const ref: ChatGptConversationRef = {
    tabId: "t1",
    url: "https://chatgpt.com/c/abc",
    conversationPath: "/c/abc",
  };
  const pendingTurns: PendingTurn[] = [];
  const openWorkerConversation = vi.fn(async () => ref);
  const sendPrompt = vi.fn(
    async (_ref: ChatGptConversationRef, _text: string): Promise<void> => {},
  );
  const waitForWorkerTurn = vi.fn(
    (
      _ref: ChatGptConversationRef,
      submittedText: string,
      onGenerating: (generating: boolean) => void,
    ) =>
      new Promise<string>((resolve, reject) => {
        pendingTurns.push({ submittedText, onGenerating, resolve, reject });
      }),
  );
  const onNotice = vi.fn();
  const broker = new ChatGptWorkerBroker({
    workspaceRoot: "/tmp/ws",
    maxWorkers: 2,
    openWorkerConversation,
    sendPrompt,
    waitForWorkerTurn,
    onNotice,
  });
  const context: ConnectorCallContext = {
    workspaceRoot: "/tmp/ws",
    threadId: "thread-1",
    turnId: "turn-1",
    agents: broker,
    exec: {} as never,
  };
  const pendingTurn = (index = 0): PendingTurn => {
    const turn = pendingTurns[index];
    if (!turn) throw new Error(`no pending worker turn at index ${index}`);
    return turn;
  };
  return {
    broker,
    context,
    onNotice,
    openWorkerConversation,
    pendingTurn,
    pendingTurns,
    ref,
    sendPrompt,
    waitForWorkerTurn,
  };
};

describe("ChatGptWorkerBroker", () => {
  it("spawns workers into free slots, refuses overflow, and reuses identical workers", async () => {
    const harness = createHarness();

    const first = await harness.broker.spawn(harness.context, {
      workers: [{ task: "task one" }, { task: "task two", label: "second" }],
    });
    const firstText = toolText(first);
    expect(firstText).toContain("Spawned: worker-1, worker-2.");
    expect(firstText).toContain("Free slots: 0.");
    expect(harness.openWorkerConversation).toHaveBeenCalledTimes(2);
    expect(harness.sendPrompt).toHaveBeenCalledTimes(2);
    const bootstrap = harness.sendPrompt.mock.calls[0]?.[1] ?? "";
    expect(bootstrap).toContain("worker-1");
    expect(harness.onNotice).not.toHaveBeenCalled();

    const overflow = await harness.broker.spawn(harness.context, {
      workers: [{ task: "task three" }],
    });
    expect(overflow.isError).toBe(true);
    expect(toolText(overflow)).toContain("only 0 worker slot(s) are free");

    const reused = await harness.broker.spawn(harness.context, {
      workers: [{ task: "task one" }, { task: "task two", label: "second" }],
    });
    const reusedText = toolText(reused);
    expect(reusedText).toContain("No workers spawned");
    expect(reusedText).toContain("Reused: worker-1, worker-2.");
    expect(reusedText).toContain("Free slots: 0.");
    expect(harness.openWorkerConversation).toHaveBeenCalledTimes(2);
  });

  it("queues a message while the worker is generating and drains it after the turn", async () => {
    const harness = createHarness();
    await harness.broker.spawn(harness.context, { workers: [{ task: "collect data" }] });
    harness.pendingTurn(0).onGenerating(true);

    const queued = await harness.broker.message(harness.context, {
      to: "worker-1",
      text: "follow up",
    });
    expect(toolText(queued)).toContain("worker-1 queued");
    expect(harness.sendPrompt).toHaveBeenCalledTimes(1);

    harness.pendingTurn(0).resolve("answer text");
    await vi.waitFor(
      () => {
        expect(harness.sendPrompt).toHaveBeenCalledWith(harness.ref, "follow up");
      },
      { timeout: 1_000, interval: 10 },
    );
    expect(harness.broker.snapshot("thread-1").workers[0]?.queuedMessages).toBe(0);
  });

  it("records a finish, delivers the inbox note once, and answers repeats", async () => {
    const harness = createHarness();
    await harness.broker.spawn(harness.context, {
      workers: [{ task: "alpha" }, { task: "beta" }],
    });
    // Only worker-1 owns a live generation, so a finish without worker_id
    // must be attributed to it.
    harness.pendingTurn(0).onGenerating(true);

    const finished = await harness.broker.finish(harness.context, { result: "done" });
    const finishedText = toolText(finished);
    expect(finishedText).toContain("Result recorded for worker-1");
    expect(finished.structuredContent).toMatchObject({ workerId: "worker-1", reported: true });

    const inbox = harness.broker.takeInbox(harness.context);
    expect(inbox).toContain("worker-1: [finished] done");
    expect(harness.broker.takeInbox(harness.context)).toBe("");

    const repeat = await harness.broker.finish(harness.context, {
      result: "done again",
      worker_id: "worker-1",
    });
    expect(toolText(repeat)).toContain("already reported");

    expect(harness.broker.snapshot("thread-1").workers[0]).toMatchObject({
      id: "worker-1",
      status: "sleeping",
      lastResult: "done",
    });
  });

  it("reports worker lines and a structured snapshot after spawn", async () => {
    const harness = createHarness();
    await harness.broker.spawn(harness.context, {
      workers: [{ task: "one", model: "gpt-5", reasoning_effort: "high" }, { task: "two" }],
    });

    const status = await harness.broker.status(harness.context);
    const text = toolText(status);
    expect(text).toContain("worker-1");
    expect(text).toContain("worker-2");
    expect(text).toContain("Free slots: 0. pending reports: 0.");

    const snapshot = harness.broker.snapshot("thread-1");
    expect(snapshot.threadId).toBe("thread-1");
    expect(snapshot.workers.map((worker) => worker.id)).toEqual(["worker-1", "worker-2"]);
    expect(snapshot.workers[0]).toMatchObject({
      status: "active",
      queuedMessages: 0,
      lastResult: null,
      model: "gpt-5",
      reasoningEffort: "high",
    });
    expect(snapshot.workers[1]?.model).toBeNull();
    expect(snapshot.freeSlots).toBe(0);
    expect(snapshot.pendingInbox).toBe(0);
  });

  it("treats a rate-limited worker turn as sleeping and keeps the worker reusable", async () => {
    const harness = createHarness();
    await harness.broker.spawn(harness.context, { workers: [{ task: "one" }] });

    harness
      .pendingTurn(0)
      .reject(
        new ChatGptWorkerRateLimitedError(
          "Too many requests You have been temporarily limited for a few minutes.",
        ),
      );

    await vi.waitFor(() => {
      expect(harness.broker.snapshot("thread-1").workers[0]?.status).toBe("sleeping");
    });
    expect(harness.onNotice).toHaveBeenCalledWith(expect.stringContaining("rate limit"));

    const message = await harness.broker.message(harness.context, {
      to: "worker-1",
      text: "continue",
    });
    expect(toolText(message)).toContain("worker-1 woken");
    expect(harness.broker.snapshot("thread-1").workers[0]?.status).toBe("active");
  });

  it("reports a rate-limited wake without marking the worker failed", async () => {
    const harness = createHarness();
    await harness.broker.spawn(harness.context, { workers: [{ task: "one" }] });
    harness.pendingTurn(0).resolve("done");
    await vi.waitFor(() => {
      expect(harness.broker.snapshot("thread-1").workers[0]?.status).toBe("sleeping");
    });

    harness.sendPrompt.mockRejectedValueOnce(
      new ChatGptWorkerRateLimitedError("Too many requests Please try again in a few minutes."),
    );

    const message = await harness.broker.message(harness.context, {
      to: "worker-1",
      text: "one more thing",
    });

    expect(message.isError).toBe(true);
    expect(toolText(message)).toContain("rate limit");
    expect(harness.broker.snapshot("thread-1").workers[0]?.status).toBe("sleeping");
  });
});
