// FILE: workers.ts
// Purpose: Prime/worker orchestration for the ChatGPT connector: spawn worker
//          chats, deliver and queue messages, collect finishes, and hand
//          worker reports back to the prime conversation.
// Layer: Server provider connector
//
// Adapted from Chat On Steroids (MIT) — src/main/agents.ts (state machine,
// slot accounting, sleep/wake, finish handoff). Synara's version runs the
// worker chats in the same browser session as the prime: every worker is a
// real ChatGPT conversation the driver can send to and read from.

import type { McpToolCallResult } from "../../agentGateway/protocol.ts";
import { mcpToolResultError } from "../../agentGateway/protocol.ts";
import { buildWorkerBootstrap } from "./instructions.ts";
import type { ConnectorCallContext } from "./runtime.ts";
import { prependChatGptPromptContext } from "../chatgptWeb/userPrompt.ts";
import type {
  ConnectorAgentBridge,
  ConnectorAgentFinishInput,
  ConnectorAgentMessageInput,
  ConnectorAgentSpawnInput,
  ConnectorAgentSpawnWorker,
} from "./tools/agents.ts";
import type { ChatGptConversationRef } from "../chatgptWeb/types.ts";

export type ChatGptWorkerStatus = "active" | "sleeping" | "finished" | "failed";

/**
 * Thrown by the adapter's worker-turn reader when ChatGPT is throttling access.
 * Distinct from a generic failure: the worker is not broken, it is sleeping on
 * a provider limit and can be woken once the limit clears.
 */
export class ChatGptWorkerRateLimitedError extends Error {
  readonly notice: string;

  constructor(notice: string) {
    super(notice);
    this.name = "ChatGptWorkerRateLimitedError";
    this.notice = notice;
  }
}

export interface ChatGptWorkerSnapshot {
  readonly id: string;
  readonly label: string;
  readonly status: ChatGptWorkerStatus;
  readonly queuedMessages: number;
  readonly lastResult: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

export interface ChatGptRunSnapshot {
  readonly threadId: string;
  readonly workers: ReadonlyArray<ChatGptWorkerSnapshot>;
  readonly freeSlots: number;
  readonly pendingInbox: number;
}

export interface ChatGptWorkerBrokerOptions {
  readonly workspaceRoot: string;
  readonly maxWorkers: number;
  readonly openWorkerConversation: (input: {
    readonly model?: string;
    readonly reasoningEffort?: string;
  }) => Promise<ChatGptConversationRef>;
  readonly sendPrompt: (
    ref: ChatGptConversationRef,
    text: string,
    submittedText?: string,
  ) => Promise<void>;
  readonly waitForWorkerTurn: (
    ref: ChatGptConversationRef,
    submittedText: string,
    onGenerating: (generating: boolean) => void,
  ) => Promise<string>;
  readonly onNotice?: (notice: string) => void;
}

interface WorkerState {
  readonly id: string;
  readonly label: string;
  readonly task: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly conversation: ChatGptConversationRef;
  status: ChatGptWorkerStatus;
  queuedMessages: string[];
  lastResult: string | null;
  finishedViaTool: boolean;
  generating: boolean;
  watcherActive: boolean;
}

interface PrimeRun {
  readonly threadId: string;
  readonly workers: Map<string, WorkerState>;
  readonly inbox: string[];
}

const MAX_TOTAL_WORKERS = 8;
const MAX_QUEUED_MESSAGES_PER_WORKER = 20;
const MAX_QUEUE_TEXT_CHARS = 4000;

const excerpt = (value: string, max = 400): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;

const workerLine = (worker: WorkerState): string => {
  const details: string[] = [`${worker.id} (${worker.label})`, worker.status];
  if (worker.queuedMessages.length > 0) details.push(`${worker.queuedMessages.length} queued`);
  if (worker.lastResult) details.push(`result: ${excerpt(worker.lastResult, 200)}`);
  return details.join(" · ");
};

export class ChatGptWorkerBroker implements ConnectorAgentBridge {
  private readonly options: ChatGptWorkerBrokerOptions;
  private readonly runs = new Map<string, PrimeRun>();

  constructor(options: ChatGptWorkerBrokerOptions) {
    this.options = options;
  }

  private runFor(threadId: string): PrimeRun {
    const existing = this.runs.get(threadId);
    if (existing) return existing;
    const created: PrimeRun = { threadId, workers: new Map(), inbox: [] };
    this.runs.set(threadId, created);
    return created;
  }

  private activeWorkerCount(run: PrimeRun): number {
    let count = 0;
    for (const worker of run.workers.values()) {
      if (worker.status === "active") count += 1;
    }
    return count;
  }

  /** Reports not yet delivered to the prime; cleared by the connector. */
  drainInbox(threadId: string): string {
    const run = this.runs.get(threadId);
    if (!run || run.inbox.length === 0) return "";
    const lines = run.inbox.splice(0, run.inbox.length);
    return lines.join("\n");
  }

  /** Restores a batch whose containing ChatGPT prompt was never accepted. */
  restoreInbox(threadId: string, batch: string): void {
    if (batch.length === 0) return;
    const run = this.runFor(threadId);
    // Reports that arrived while the failed send was in flight stay after the
    // older restored batch, preserving delivery order on the next turn.
    run.inbox.unshift(batch);
  }

  snapshot(threadId: string): ChatGptRunSnapshot {
    const run = this.runs.get(threadId);
    if (!run) {
      return { threadId, workers: [], freeSlots: this.options.maxWorkers, pendingInbox: 0 };
    }
    return {
      threadId,
      workers: [...run.workers.values()].map((worker) => ({
        id: worker.id,
        label: worker.label,
        status: worker.status,
        queuedMessages: worker.queuedMessages.length,
        lastResult: worker.lastResult,
        model: worker.model.length > 0 ? worker.model : null,
        reasoningEffort: worker.reasoningEffort.length > 0 ? worker.reasoningEffort : null,
      })),
      freeSlots: Math.max(0, this.options.maxWorkers - this.activeWorkerCount(run)),
      pendingInbox: run.inbox.length,
    };
  }

  forgetThread(threadId: string): void {
    this.runs.delete(threadId);
  }

  takeInbox(context: ConnectorCallContext): string {
    return this.drainInbox(context.threadId);
  }

  async spawn(
    context: ConnectorCallContext,
    input: ConnectorAgentSpawnInput,
  ): Promise<McpToolCallResult> {
    const run = this.runFor(context.threadId);
    const identifiable = input.workers.filter((worker) => worker.task.trim().length > 0);

    // A repeated identical spawn reuses live workers instead of burning slots.
    const reusable: WorkerState[] = [];
    const fresh: ConnectorAgentSpawnWorker[] = [];
    for (const worker of identifiable) {
      const match = [...run.workers.values()].find(
        (candidate) =>
          candidate.status !== "failed" &&
          candidate.task === worker.task.trim() &&
          candidate.label === (worker.label ?? worker.task.trim().slice(0, 30)),
      );
      if (match) reusable.push(match);
      else fresh.push(worker);
    }

    if (run.workers.size + fresh.length > MAX_TOTAL_WORKERS) {
      return mcpToolResultError(
        `agents: this run already owns ${run.workers.size} workers; at most ${MAX_TOTAL_WORKERS} are allowed.`,
      );
    }
    const free = this.options.maxWorkers - this.activeWorkerCount(run);
    if (fresh.length > free) {
      return mcpToolResultError(
        `agents: only ${free} worker slot(s) are free (limit ${this.options.maxWorkers}). Wait for a worker to finish or reuse a sleeping worker.`,
      );
    }

    const spawned: string[] = [];
    for (const request of fresh) {
      const label = (request.label ?? request.task.trim().slice(0, 30)).trim();
      const workerId = this.nextWorkerId(run);
      let conversation: ChatGptConversationRef;
      try {
        conversation = await this.options.openWorkerConversation({
          ...(request.model ? { model: request.model } : {}),
          ...(request.reasoning_effort ? { reasoningEffort: request.reasoning_effort } : {}),
        });
      } catch (error) {
        return mcpToolResultError(
          `agents: could not open a worker chat: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const worker: WorkerState = {
        id: workerId,
        label,
        task: request.task.trim(),
        model: request.model?.trim() ?? "",
        reasoningEffort: request.reasoning_effort?.trim() ?? "",
        conversation,
        status: "active",
        queuedMessages: [],
        lastResult: null,
        finishedViaTool: false,
        generating: false,
        watcherActive: false,
      };
      run.workers.set(workerId, worker);
      const bootstrap = buildWorkerBootstrap({
        workspaceRoot: this.options.workspaceRoot,
        workerId,
        label,
        task: worker.task,
        ...(input.context ? { sharedContext: input.context } : {}),
      });
      const framedBootstrap = prependChatGptPromptContext(worker.task, bootstrap);
      try {
        await this.options.sendPrompt(conversation, framedBootstrap, worker.task);
      } catch (error) {
        worker.status = "failed";
        this.options.onNotice?.(
          `${workerId} failed to start: ${error instanceof Error ? error.message : String(error)}`,
        );
        return mcpToolResultError(
          `agents: ${workerId} chat opened but the task could not be sent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.watch(run, worker, worker.task);
      spawned.push(workerId);
    }

    const freeAfter = Math.max(0, this.options.maxWorkers - this.activeWorkerCount(run));
    const lines = [
      spawned.length > 0
        ? `Spawned: ${spawned.join(", ")}.`
        : "No workers spawned; the requested workers already exist and are reused.",
      ...(reusable.length > 0
        ? [`Reused: ${reusable.map((worker) => worker.id).join(", ")}.`]
        : []),
      `Free slots: ${freeAfter}.`,
      "Worker reports arrive with your next tool result. Use agents status to check progress; do not poll without reason.",
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  private nextWorkerId(run: PrimeRun): string {
    for (let index = 1; index <= MAX_TOTAL_WORKERS; index += 1) {
      const id = `worker-${index}`;
      if (!run.workers.has(id)) return id;
    }
    return `worker-${run.workers.size + 1}`;
  }

  /**
   * Watches one worker chat until it stops owning a turn: collects the final
   * answer, publishes it to the prime inbox, and wakes the worker when queued
   * messages are waiting.
   */
  private watch(run: PrimeRun, worker: WorkerState, submittedText: string): void {
    if (worker.watcherActive) return;
    worker.watcherActive = true;
    void (async () => {
      let submitted = submittedText;
      try {
        for (;;) {
          const answer = await this.options.waitForWorkerTurn(
            worker.conversation,
            submitted,
            (generating) => {
              worker.generating = generating;
            },
          );
          worker.generating = false;
          if (worker.status === "failed") break;

          if (!worker.finishedViaTool && answer.trim().length > 0) {
            worker.lastResult = answer.trim();
            run.inbox.push(`• ${worker.id}: [reported] ${excerpt(worker.lastResult, 2000)}`);
            worker.status = "sleeping";
          } else if (worker.finishedViaTool) {
            worker.status = "sleeping";
          } else if (worker.status === "active") {
            // Turn ended without an answer; treat it as a completed (empty) turn.
            worker.status = "sleeping";
          }

          const next = worker.queuedMessages.shift();
          if (next === undefined) break;
          submitted = next;
          worker.status = "active";
          try {
            await this.options.sendPrompt(worker.conversation, next);
          } catch (error) {
            worker.status = "failed";
            this.options.onNotice?.(
              `${worker.id} could not receive a queued message: ${error instanceof Error ? error.message : String(error)}`,
            );
            break;
          }
        }
      } catch (error) {
        if (error instanceof ChatGptWorkerRateLimitedError) {
          // The worker chat is intact; ChatGPT is only throttling access.
          worker.generating = false;
          worker.status = "sleeping";
          this.options.onNotice?.(
            `${worker.id} hit ChatGPT's rate limit (${error.notice}). Message it again in a few minutes to continue; its history is kept.`,
          );
        } else {
          worker.status = worker.status === "failed" ? "failed" : "sleeping";
          this.options.onNotice?.(
            `${worker.id} stopped being watched: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        worker.watcherActive = false;
      }
    })();
  }

  async message(
    context: ConnectorCallContext,
    input: ConnectorAgentMessageInput,
  ): Promise<McpToolCallResult> {
    const messages =
      input.messages ?? (input.to && input.text ? [{ to: input.to, text: input.text }] : []);
    if (messages.length === 0) {
      return mcpToolResultError("agents: no message recipients were provided.");
    }
    const run = this.runFor(context.threadId);
    const acknowledged: string[] = [];
    for (const message of messages) {
      const worker = run.workers.get(message.to.trim());
      if (!worker) {
        return mcpToolResultError(
          `agents: unknown recipient "${message.to}". Workers: ${[...run.workers.keys()].join(", ") || "(none)"}.`,
        );
      }
      if (worker.status === "failed") {
        return mcpToolResultError(`agents: ${worker.id} has failed and cannot receive messages.`);
      }
      if (worker.task.trim().toLowerCase() === message.text.trim().toLowerCase()) {
        return mcpToolResultError(`agents: refusing to echo ${worker.id}'s own task back to it.`);
      }
      if (message.text.length > MAX_QUEUE_TEXT_CHARS) {
        return mcpToolResultError(
          `agents: messages may not exceed ${MAX_QUEUE_TEXT_CHARS} characters.`,
        );
      }
      if (worker.status === "active" && worker.generating) {
        if (worker.queuedMessages.length >= MAX_QUEUED_MESSAGES_PER_WORKER) {
          return mcpToolResultError(`agents: ${worker.id} has too many queued messages.`);
        }
        worker.queuedMessages.push(message.text);
        acknowledged.push(`${worker.id} queued`);
        continue;
      }
      if (worker.status === "finished") {
        return mcpToolResultError(`agents: ${worker.id} is finished and cannot be revived.`);
      }
      const wasSleeping = worker.status === "sleeping";
      worker.status = "active";
      if (wasSleeping || !worker.watcherActive) {
        try {
          await this.options.sendPrompt(worker.conversation, message.text);
        } catch (error) {
          if (error instanceof ChatGptWorkerRateLimitedError) {
            worker.status = "sleeping";
            return mcpToolResultError(
              `agents: ${worker.id} is waiting on ChatGPT's rate limit (${error.notice}). Retry in a few minutes.`,
            );
          }
          worker.status = "failed";
          return mcpToolResultError(
            `agents: could not wake ${worker.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        this.watch(run, worker, message.text);
        acknowledged.push(`${worker.id} ${wasSleeping ? "woken" : "messaged"}`);
      } else {
        if (worker.queuedMessages.length >= MAX_QUEUED_MESSAGES_PER_WORKER) {
          return mcpToolResultError(`agents: ${worker.id} has too many queued messages.`);
        }
        worker.queuedMessages.push(message.text);
        acknowledged.push(`${worker.id} queued`);
      }
    }
    return {
      content: [
        {
          type: "text",
          text: `Message delivery: ${acknowledged.join("; ")}. Reports will arrive with your next tool result.`,
        },
      ],
    };
  }

  async status(context: ConnectorCallContext): Promise<McpToolCallResult> {
    const snapshot = this.snapshot(context.threadId);
    if (snapshot.workers.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No workers in this run. Free slots: ${snapshot.freeSlots}. pending reports: ${snapshot.pendingInbox}.`,
          },
        ],
      };
    }
    const run = this.runs.get(context.threadId);
    const lines = [...(run?.workers.values() ?? [])].map((worker) => `• ${workerLine(worker)}`);
    lines.push(`Free slots: ${snapshot.freeSlots}. pending reports: ${snapshot.pendingInbox}.`);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        workers: snapshot.workers.map((worker) => ({ ...worker })),
        freeSlots: snapshot.freeSlots,
        pendingInbox: snapshot.pendingInbox,
      },
    };
  }

  async finish(
    context: ConnectorCallContext,
    input: ConnectorAgentFinishInput & { readonly worker_id?: string },
  ): Promise<McpToolCallResult> {
    const run = this.runFor(context.threadId);
    const requested = input.worker_id?.trim();
    let worker: WorkerState | undefined;
    if (requested) {
      worker = run.workers.get(requested);
      if (!worker) {
        return mcpToolResultError(
          `agents: unknown worker_id "${requested}". Your id was provided in your bootstrap message.`,
        );
      }
    } else {
      // Without an explicit id, bind only when exactly one worker is generating.
      const generating = [...run.workers.values()].filter(
        (candidate) => candidate.status === "active" && candidate.generating,
      );
      const onlyGenerating = generating.length === 1 ? generating[0] : undefined;
      const onlyWorker =
        generating.length === 0 && run.workers.size === 1
          ? [...run.workers.values()][0]
          : undefined;
      worker = onlyGenerating ?? onlyWorker;
      if (!worker) {
        return mcpToolResultError(
          "agents: finish could not be attributed to a worker. Pass `worker_id` (provided in your bootstrap message).",
        );
      }
    }
    if (worker.finishedViaTool) {
      const previous = worker.lastResult ?? "(no result)";
      return {
        content: [
          {
            type: "text",
            text: `${worker.id} already reported. Previous result: ${excerpt(previous, 400)}. It is sleeping; send it another message to reuse it.`,
          },
        ],
      };
    }
    worker.finishedViaTool = true;
    worker.lastResult = input.result.trim();
    worker.status = "sleeping";
    run.inbox.push(`• ${worker.id}: [finished] ${excerpt(worker.lastResult, 2000)}`);
    return {
      content: [
        {
          type: "text",
          text: `Result recorded for ${worker.id}. You may stop working; the prime conversation will receive it with its next tool result.`,
        },
      ],
      structuredContent: { workerId: worker.id, reported: true },
    };
  }
}
