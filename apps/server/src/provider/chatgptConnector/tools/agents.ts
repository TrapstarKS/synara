// FILE: tools/agents.ts
// Purpose: Model-facing `agents` tool: prime/worker orchestration over ChatGPT
//          conversations, ported from Chat On Steroids' prime/worker protocol.
// Layer: Server provider connector / tool surface
//
// Adapted from Chat On Steroids (MIT) — src/main/mcp/tools-core.ts and
// src/main/agents.ts. The tool is one flat `action`-discriminated schema; the
// bridge it calls lives on the thread runtime and owns the browser work
// (opening worker chats, delivering messages, collecting results).

import type { McpToolCallResult, McpToolDefinition } from "../../../agentGateway/protocol.ts";
import { mcpToolResultError, mcpToolResultJson } from "../../../agentGateway/protocol.ts";
import type { ConnectorCallContext } from "../runtime.ts";

export const AGENT_REASONING_EFFORTS = [
  "pro",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const AGENT_MAX_WORKERS_PER_SPAWN = 8;
export const AGENT_MAX_BATCH_MESSAGES = 16;

export interface ConnectorAgentSpawnWorker {
  readonly label?: string;
  readonly task: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
}

export interface ConnectorAgentSpawnInput {
  readonly context?: string;
  readonly workers: ReadonlyArray<ConnectorAgentSpawnWorker>;
}

export interface ConnectorAgentMessageInput {
  readonly messages?: ReadonlyArray<{ readonly to: string; readonly text: string }>;
  readonly to?: string;
  readonly text?: string;
}

export interface ConnectorAgentFinishInput {
  readonly result: string;
  /** Worker chats pass the id from their bootstrap when attribution is ambiguous. */
  readonly worker_id?: string;
}

export interface ConnectorAgentBridge {
  /**
   * Drains messages queued for the prime conversation (worker reports) so the
   * connector can attach them to the next tool result.
   */
  readonly takeInbox?: (context: ConnectorCallContext) => string;
  readonly spawn: (
    context: ConnectorCallContext,
    input: ConnectorAgentSpawnInput,
  ) => Promise<McpToolCallResult>;
  readonly message: (
    context: ConnectorCallContext,
    input: ConnectorAgentMessageInput,
  ) => Promise<McpToolCallResult>;
  readonly status: (context: ConnectorCallContext) => Promise<McpToolCallResult>;
  readonly finish: (
    context: ConnectorCallContext,
    input: ConnectorAgentFinishInput,
  ) => Promise<McpToolCallResult>;
}

export const AGENTS_TOOL_DEFINITION: McpToolDefinition = {
  name: "agents",
  description:
    "Coordinate worker chats. spawn creates worker ChatGPT chats from one shared context plus per-worker tasks; used once per run (reuse a worker instead of spawning again). message sends text to workers (or the prime) and wakes a sleeping worker; status reports the run and workers; finish is a worker's handoff to the prime with its result. Workers sleep rather than end: their conversation is durable, and messaging a sleeping worker reuses it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["spawn", "message", "status", "finish"] },
      context: {
        type: "string",
        maxLength: 4000,
        description: "Shared context handed to every worker in this spawn (spawn only).",
      },
      workers: {
        type: "array",
        minItems: 1,
        maxItems: AGENT_MAX_WORKERS_PER_SPAWN,
        description: "Workers to create (spawn only).",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string", maxLength: 60 },
            task: { type: "string", minLength: 1, maxLength: 4000 },
            model: {
              type: "string",
              maxLength: 80,
              description: "Optional ChatGPT model slug for the worker chat.",
            },
            reasoning_effort: {
              type: "string",
              enum: [...AGENT_REASONING_EFFORTS],
            },
          },
          required: ["task"],
        },
      },
      messages: {
        type: "array",
        minItems: 1,
        maxItems: AGENT_MAX_BATCH_MESSAGES,
        description: "All-or-nothing batch of messages (message only).",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            to: { type: "string", minLength: 1, maxLength: 40 },
            text: { type: "string", minLength: 1, maxLength: 4000 },
          },
          required: ["to", "text"],
        },
      },
      to: {
        type: "string",
        minLength: 1,
        maxLength: 40,
        description: "Single message recipient (message only).",
      },
      text: {
        type: "string",
        minLength: 1,
        maxLength: 4000,
        description: "Single message text (message only).",
      },
      result: {
        type: "string",
        minLength: 1,
        maxLength: 4000,
        description: "Worker handoff result (finish only).",
      },
      worker_id: {
        type: "string",
        minLength: 1,
        maxLength: 40,
        description:
          "The worker's own id from its bootstrap message (finish only; optional when attribu" +
          "tion is unambiguous).",
      },
    },
    required: ["action"],
  },
  annotations: {
    title: "Agents",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function requireString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null | { readonly invalid: true } {
  const value = record[key];
  if (value === undefined) return null;
  if (typeof value !== "string") return { invalid: true };
  const trimmed = value.trim();
  if (trimmed.length > maxLength) return { invalid: true };
  return trimmed.length === 0 ? null : trimmed;
}

export function parseAgentSpawnInput(args: unknown): ConnectorAgentSpawnInput | string {
  const record = asRecord(args);
  if (!record) return "agents: arguments must be an object.";
  const workersValue = record.workers;
  if (!Array.isArray(workersValue) || workersValue.length === 0) {
    return "agents: spawn requires a non-empty workers array.";
  }
  if (workersValue.length > AGENT_MAX_WORKERS_PER_SPAWN) {
    return `agents: spawn accepts at most ${AGENT_MAX_WORKERS_PER_SPAWN} workers per call.`;
  }
  const workers: ConnectorAgentSpawnWorker[] = [];
  for (const [index, rawWorker] of workersValue.entries()) {
    const worker = asRecord(rawWorker);
    if (!worker) return `agents: workers[${index}] must be an object.`;
    const task = requireString(worker, "task", 4000);
    if (!task) return `agents: workers[${index}].task is required (1-4000 chars).`;
    const label = optionalString(worker, "label", 60);
    if (label && typeof label === "object") {
      return `agents: workers[${index}].label must be a string up to 60 chars.`;
    }
    const model = optionalString(worker, "model", 80);
    if (model && typeof model === "object") {
      return `agents: workers[${index}].model must be a string up to 80 chars.`;
    }
    const reasoningEffort = optionalString(worker, "reasoning_effort", 16);
    if (reasoningEffort && typeof reasoningEffort === "object") {
      return `agents: workers[${index}].reasoning_effort must be a string.`;
    }
    if (
      reasoningEffort &&
      !(AGENT_REASONING_EFFORTS as ReadonlyArray<string>).includes(reasoningEffort)
    ) {
      return `agents: workers[${index}].reasoning_effort must be one of ${AGENT_REASONING_EFFORTS.join(", ")}.`;
    }
    workers.push({
      task,
      ...(typeof label === "string" ? { label } : {}),
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof reasoningEffort === "string" ? { reasoning_effort: reasoningEffort } : {}),
    });
  }
  const context = optionalString(record, "context", 4000);
  if (context && typeof context === "object") {
    return "agents: context must be a string up to 4000 chars.";
  }
  return {
    workers,
    ...(typeof context === "string" ? { context } : {}),
  };
}

export function parseAgentMessageInput(args: unknown): ConnectorAgentMessageInput | string {
  const record = asRecord(args);
  if (!record) return "agents: arguments must be an object.";
  const messagesValue = record.messages;
  const hasBatch = messagesValue !== undefined;
  const hasSingle = record.to !== undefined || record.text !== undefined;
  if (hasBatch && hasSingle) {
    return "agents: pass either a single to/text pair or a messages batch, not both.";
  }
  if (hasBatch) {
    if (!Array.isArray(messagesValue) || messagesValue.length === 0) {
      return "agents: messages must be a non-empty array.";
    }
    if (messagesValue.length > AGENT_MAX_BATCH_MESSAGES) {
      return `agents: message accepts at most ${AGENT_MAX_BATCH_MESSAGES} messages per batch.`;
    }
    const messages: Array<{ to: string; text: string }> = [];
    for (const [index, raw] of messagesValue.entries()) {
      const entry = asRecord(raw);
      if (!entry) return `agents: messages[${index}] must be an object.`;
      const to = requireString(entry, "to", 40);
      const text = requireString(entry, "text", 4000);
      if (!to) return `agents: messages[${index}].to is required (1-40 chars).`;
      if (!text) return `agents: messages[${index}].text is required (1-4000 chars).`;
      messages.push({ to, text });
    }
    return { messages };
  }
  const to = requireString(record, "to", 40);
  const text = requireString(record, "text", 4000);
  if (!to) return "agents: message requires `to` (1-40 chars).";
  if (!text) return "agents: message requires `text` (1-4000 chars).";
  return { to, text };
}

export function parseAgentFinishInput(args: unknown): ConnectorAgentFinishInput | string {
  const record = asRecord(args);
  if (!record) return "agents: arguments must be an object.";
  const result = requireString(record, "result", 4000);
  if (!result) return "agents: finish requires `result` (1-4000 chars).";
  const workerId = optionalString(record, "worker_id", 40);
  if (workerId && typeof workerId === "object") {
    return "agents: finish `worker_id` must be a string up to 40 chars.";
  }
  return { result, ...(typeof workerId === "string" ? { worker_id: workerId } : {}) };
}

export function createAgentsTool() {
  return {
    definition: AGENTS_TOOL_DEFINITION,
    handler: async (context: ConnectorCallContext, args: unknown): Promise<McpToolCallResult> => {
      const record = asRecord(args);
      const action = typeof record?.action === "string" ? record.action : null;
      if (!action) {
        return mcpToolResultError(
          'agents: `action` must be one of "spawn", "message", "status", "finish".',
        );
      }
      switch (action) {
        case "spawn": {
          const parsed = parseAgentSpawnInput(args);
          if (typeof parsed === "string") return mcpToolResultError(parsed);
          return context.agents.spawn(context, parsed);
        }
        case "message": {
          const parsed = parseAgentMessageInput(args);
          if (typeof parsed === "string") return mcpToolResultError(parsed);
          return context.agents.message(context, parsed);
        }
        case "status":
          return context.agents.status(context);
        case "finish": {
          const parsed = parseAgentFinishInput(args);
          if (typeof parsed === "string") return mcpToolResultError(parsed);
          return context.agents.finish(context, parsed);
        }
        default:
          return mcpToolResultError(`agents: unknown action "${action}".`);
      }
    },
  };
}

export { mcpToolResultJson };
