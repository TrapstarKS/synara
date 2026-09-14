// FILE: tools/index.ts
// Purpose: The tool table ChatGPT sees through the Synara connector: file
//          reads, V4A patches, shell sessions and the agents orchestration.
// Layer: Server provider connector / tool surface
//
// The surface is deliberately small (six tools) because ChatGPT's developer
// mode truncates a connector's tool list at 64 entries and every schema counts
// against the discovery size the model must load. Tool handlers receive the
// attributed `ConnectorCallContext`; they never resolve identity themselves.

import type { McpToolCallResult, McpToolDefinition } from "../../../agentGateway/protocol.ts";
import { mcpToolResultError } from "../../../agentGateway/protocol.ts";
import type { ConnectorCallContext } from "../runtime.ts";
import { runApplyPatchTool } from "./applyPatch.ts";
import { createAgentsTool } from "./agents.ts";
import { runReadTool, resolveWithinRoot } from "./read.ts";

export interface ChatGptConnectorTool {
  readonly definition: McpToolDefinition;
  readonly handler: (context: ConnectorCallContext, args: unknown) => Promise<McpToolCallResult>;
}

const READ_TOOL_DEFINITION: McpToolDefinition = {
  name: "read",
  description:
    "Read files and directories from the Synara workspace. Accepts one or more paths (relative to the workspace root or absolute inside it). Directories list one level deep; bounded globs are supported in the final segment. Large reads are truncated with an explicit note, so batch related paths into one call.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      paths: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string" },
        description: "Files, directories, or bounded globs to read.",
      },
      start_line: {
        type: "integer",
        minimum: 1,
        description: "1-based first line for text files.",
      },
      end_line: { type: "integer", minimum: 1, description: "1-based last line for text files." },
      max_bytes: {
        type: "integer",
        minimum: 1,
        description: "Per-file payload cap (default 256 KiB, max 512 KiB).",
      },
    },
    required: ["paths"],
  },
  annotations: { title: "Read", readOnlyHint: true, openWorldHint: false },
};

const APPLY_PATCH_TOOL_DEFINITION: McpToolDefinition = {
  name: "apply_patch",
  description:
    "Edit workspace files with a V4A patch. Wrap the patch in '*** Begin Patch' / '*** End Patch'. Sections: '*** Add File: <path>' (every body line prefixed '+'), '*** Update File: <path>' (optional '*** Move to: <path>', then hunks starting with '@@' using ' ' context, '-' removed and '+' added lines), '*** Delete File: <path>'. The whole patch is preflighted atomically: if any hunk does not match, nothing is written.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      patch: { type: "string", description: "The full V4A patch envelope." },
    },
    required: ["patch"],
  },
  annotations: { title: "Apply Patch", destructiveHint: true, openWorldHint: false },
};

const EXEC_COMMAND_TOOL_DEFINITION: McpToolDefinition = {
  name: "exec_command",
  description:
    "Run one shell command in the workspace, using the host's real shell with your normal user privileges. Long-running commands return a session_id that write_stdin continues. The command is not sandboxed to the workspace. Prefer batching related checks with '&&' or ';' inside one command.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      cmd: { type: "string", description: "The command to run." },
      workdir: {
        type: "string",
        description: "Working directory relative to the workspace root (defaults to the root).",
      },
      yield_time_ms: {
        type: "integer",
        minimum: 1000,
        maximum: 30000,
        description: "How long to wait before returning a live session (default 10000).",
      },
    },
    required: ["cmd"],
  },
  annotations: { title: "Exec Command", destructiveHint: true, openWorldHint: true },
};

const WRITE_STDIN_TOOL_DEFINITION: McpToolDefinition = {
  name: "write_stdin",
  description:
    "Write to or poll a live command session created by exec_command. A blank `chars` value polls current output; write the session's stdin otherwise. Polls return as soon as new output arrives and buffer the rest for the next poll.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      session_id: { type: "integer", minimum: 1 },
      chars: {
        type: "string",
        description: "Text to send to the session's stdin; omit or leave blank to poll.",
      },
      yield_time_ms: { type: "integer", minimum: 250, maximum: 30000 },
    },
    required: ["session_id"],
  },
  annotations: { title: "Write Stdin", destructiveHint: true, openWorldHint: true },
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function renderExecResult(result: {
  readonly output: string;
  readonly exitCode: number | null;
  readonly running: boolean;
  readonly sessionId: number | null;
  readonly wallTimeSeconds: number;
}): McpToolCallResult {
  const lines: string[] = [`Wall time: ${result.wallTimeSeconds} seconds`];
  if (result.running) {
    lines.push(`Process running with session ID ${result.sessionId ?? "?"}`);
  } else if (result.exitCode !== null) {
    lines.push(`Process exited with code ${result.exitCode}`);
  } else {
    lines.push("Process exited");
  }
  lines.push("Output:");
  lines.push(result.output.length > 0 ? result.output : "(no output)");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function renderPollResult(result: {
  readonly output: string;
  readonly exitCode: number | null;
  readonly running: boolean;
}): McpToolCallResult {
  const lines: string[] = [];
  if (result.running) {
    lines.push("Process running.");
  } else if (result.exitCode !== null) {
    lines.push(`Process exited with code ${result.exitCode}`);
  } else {
    lines.push("Process exited.");
  }
  lines.push("Output:");
  lines.push(result.output.length > 0 ? result.output : "(no output)");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const clampYieldMs = (value: unknown, min: number, max: number, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
};

const readTool: ChatGptConnectorTool = {
  definition: READ_TOOL_DEFINITION,
  handler: async (context, args) => {
    const record = asRecord(args);
    if (!record) return mcpToolResultError("read: arguments must be an object.");
    const paths = record.paths;
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string")) {
      return mcpToolResultError("read: `paths` must be a non-empty array of strings.");
    }
    return runReadTool(context, {
      paths: paths as ReadonlyArray<string>,
      ...(typeof record.start_line === "number" ? { start_line: record.start_line } : {}),
      ...(typeof record.end_line === "number" ? { end_line: record.end_line } : {}),
      ...(typeof record.max_bytes === "number" ? { max_bytes: record.max_bytes } : {}),
    });
  },
};

const applyPatchTool: ChatGptConnectorTool = {
  definition: APPLY_PATCH_TOOL_DEFINITION,
  handler: async (context, args) => {
    const record = asRecord(args);
    const patch = typeof record?.patch === "string" ? record.patch : null;
    if (patch === null || patch.trim().length === 0) {
      return mcpToolResultError("apply_patch: `patch` must be a non-empty string.");
    }
    const outcome = await runApplyPatchTool(context, { patch });
    if (!outcome.ok) return mcpToolResultError(`apply_patch failed: ${outcome.error}`);
    const body = outcome.summary.length > 0 ? outcome.summary.join("\n") : "(no changes)";
    return { content: [{ type: "text", text: `Patch applied:\n${body}` }] };
  },
};

const execCommandTool: ChatGptConnectorTool = {
  definition: EXEC_COMMAND_TOOL_DEFINITION,
  handler: async (context, args) => {
    const record = asRecord(args);
    const cmd = typeof record?.cmd === "string" ? record.cmd : null;
    if (cmd === null || cmd.trim().length === 0) {
      return mcpToolResultError("exec_command: `cmd` must be a non-empty string.");
    }
    let cwd = context.workspaceRoot;
    if (typeof record?.workdir === "string" && record.workdir.trim().length > 0) {
      try {
        cwd = resolveWithinRoot(context.workspaceRoot, record.workdir.trim()).absolutePath;
      } catch (error) {
        return mcpToolResultError(`exec_command: invalid workdir (${errorMessage(error)}).`);
      }
    }
    try {
      const result = await context.exec.run({
        command: cmd,
        cwd,
        ...(context.signal ? { signal: context.signal } : {}),
        yieldMs: clampYieldMs(record?.yield_time_ms, 1000, 30000, 10_000),
      });
      return renderExecResult(result);
    } catch (error) {
      return mcpToolResultError(`exec_command failed: ${errorMessage(error)}`);
    }
  },
};

const writeStdinTool: ChatGptConnectorTool = {
  definition: WRITE_STDIN_TOOL_DEFINITION,
  handler: async (context, args) => {
    const record = asRecord(args);
    const sessionId = record?.session_id;
    if (typeof sessionId !== "number" || !Number.isInteger(sessionId) || sessionId < 1) {
      return mcpToolResultError("write_stdin: `session_id` must be a positive integer.");
    }
    const chars = typeof record?.chars === "string" ? record.chars : "";
    try {
      const result = await context.exec.write(sessionId, chars, {
        yieldMs: clampYieldMs(record?.yield_time_ms, 250, 30000, 1000),
      });
      return renderPollResult(result);
    } catch (error) {
      return mcpToolResultError(`write_stdin failed: ${errorMessage(error)}`);
    }
  },
};

/** The complete connector surface, in stable order. */
export function createChatGptConnectorTools(): ReadonlyArray<ChatGptConnectorTool> {
  const agents = createAgentsTool();
  return [
    readTool,
    applyPatchTool,
    execCommandTool,
    writeStdinTool,
    { definition: agents.definition, handler: agents.handler },
  ];
}
