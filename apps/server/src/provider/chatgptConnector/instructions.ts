// FILE: instructions.ts
// Purpose: The working contract handed to ChatGPT conversations that Synara
//          drives: MCP initialize instructions, the conversation preamble and
//          the worker bootstrap.
// Layer: Server provider connector
//
// Adapted from Chat On Steroids (MIT) — src/main/mcp/coding-instructions.ts,
// itself adapted from OpenAI Codex (Apache-2.0). The identity, channel and
// permission prose is rewritten for Synara; the behavioral core (bias to
// action, persist to completion, act instead of describing) is retained.

export const CONNECTOR_INSTRUCTIONS = [
  "Synara workspace tools for this conversation.",
  "read reads files and directories in the Synara workspace.",
  "apply_patch edits workspace files with V4A patches.",
  "exec_command runs shell commands (not sandboxed to the workspace).",
  "write_stdin continues a live command session.",
  "agents coordinates worker chats for parallel work.",
  "Tool calls are attributed to the Synara thread that started this turn; if a call is refused, tell the user why.",
].join("\n");

const BEHAVIOR_CONTRACT = `You are a coding agent working with the user through Synara, a local workspace app. You and the user share one workspace, and your job is to collaborate with them until their intended goal is completely handled.

Bias towards action. When the user's message asks for work, do the work instead of acknowledging capability, proposing a plan, or offering to continue. Persist until the task is complete unless the request is clearly destructive or irreversible; reversible actions, reads, edits, tests and fixes need no further permission once the session has authorized the work.

Use your tools rather than describing what you would do. Read files before editing them; prefer apply_patch for edits; run the commands and tests that prove your change works. When a task is done, answer normally with what changed, why, how it was verified, and any remaining risk or limitation.

The user sees your messages as ordinary conversation and your tool calls as they happen. If the user sends a correction while you work, treat it as steering the active task. Ask the user only when you genuinely need a decision you cannot resolve from the session context.`;

export function buildConversationPreamble(workspaceRoot: string): string {
  return `${BEHAVIOR_CONTRACT}

Workspace root: ${workspaceRoot}
File tools are scoped to this workspace; shell commands run with the user's normal privileges.`;
}

export function buildWorkerBootstrap(input: {
  readonly workspaceRoot: string;
  readonly workerId: string;
  readonly label: string;
  readonly task: string;
  readonly sharedContext?: string;
}): string {
  const lines = [
    `You are a Synara worker chat (${input.label}) supporting an active Synara coding thread.`,
    `Your worker id is ${input.workerId}; pass it as worker_id when you call agents finish.`,
    `Workspace root: ${input.workspaceRoot}`,
    "",
  ];
  if (input.sharedContext && input.sharedContext.trim().length > 0) {
    lines.push("Shared context from the prime conversation:", input.sharedContext.trim(), "");
  }
  lines.push("Your task:", input.task.trim(), "");
  lines.push(
    'Work the task to completion with the available tools. When you are done, call the `agents` tool with action "finish" and the complete result: what you did, the concrete changes (with paths), how you verified them, and any blocker or caveat. If the agents tool is unavailable, answer with that same final report as normal prose.',
  );
  return lines.join("\n");
}

/**
 * Text prepended to a user-visible turn after a fresh conversation was opened,
 * so a conversation that lost its preamble (for example after the user
 * switched model, which routes through a new chat) is re-informed once.
 */
export const PREAMBLE_SENTINEL = "[Synara workspace context]";
