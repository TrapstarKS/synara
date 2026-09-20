import { describe, expect, it } from "vitest";

import { deriveWorkLogToolDetails } from "./toolCallDetails";

describe("tool output exit-code suffixes", () => {
  it("preserves a large whitespace run inside raw output", () => {
    const stdout = `start${" ".repeat(23_980)}end`;
    const details = deriveWorkLogToolDetails({
      label: "Command",
      command: "run",
      payload: { data: { rawOutput: { stdout } } },
    });
    expect(details?.output).toEqual({ stdout });
  });

  it.each([
    ["  output\n", "  output\n", undefined],
    ["  output\n <exited with exit code 2>\n", "  output", 2],
    ["\toutput\r\n<EXITED WITH EXIT CODE 000>\t", "\toutput", 0],
    ["<exited with exit code 1>", undefined, 1],
    ["<exited with exit code -1>", "<exited with exit code -1>", undefined],
    ["<exited with exit code 1> later", "<exited with exit code 1> later", undefined],
    ["<exited with exit code 1>\n<exited with exit code 2>", "<exited with exit code 1>", 2],
    ["\n\t", undefined, undefined],
  ])("preserves raw stdout and parses only the final suffix: %j", (stdout, output, exitCode) => {
    const details = deriveWorkLogToolDetails({
      label: "Command",
      command: "run",
      detail: stdout,
      payload: { data: { rawOutput: { stdout } } },
    });
    expect(details?.output?.stdout).toBe(output);
    expect(details?.output?.exitCode).toBe(exitCode);
  });
});

describe("native Codex v2 tool details", () => {
  it("renders command cwd, authoritative aggregated output, exit code, and duration", () => {
    const details = deriveWorkLogToolDetails({
      label: "Ran command",
      itemType: "command_execution",
      payload: {
        data: {
          item: {
            type: "commandExecution",
            command: "bun run test",
            cwd: "/repo",
            aggregatedOutput: "2 tests passed\n",
            exitCode: 0,
            durationMs: 1_234,
          },
        },
      },
      command: "bun run test",
    });
    expect(details).toMatchObject({
      kind: "command",
      command: "bun run test",
      cwd: "/repo",
      durationMs: 1_234,
      output: { output: "2 tests passed\n", exitCode: 0 },
    });
  });

  it("keeps MCP identity, arguments, app metadata, result, error, and duration inspectable", () => {
    const details = deriveWorkLogToolDetails({
      label: "MCP tool call",
      itemType: "mcp_tool_call",
      payload: {
        data: {
          item: {
            type: "mcpToolCall",
            server: "computer-use",
            tool: "get_app_state",
            arguments: { app: "Safari", includeDom: false },
            appContext: { appName: "Computer", actionName: "Get app state" },
            result: {
              content: [{ type: "text", text: "Safari is focused" }],
              structuredContent: { focused: true },
            },
            error: { message: "partial metadata unavailable" },
            durationMs: 2_500,
          },
        },
      },
    });
    expect(details).toMatchObject({
      kind: "tool-call",
      server: "computer-use",
      tool: "get_app_state",
      appName: "Computer",
      actionName: "Get app state",
      arguments: '{\n  "app": "Safari",\n  "includeDom": false\n}',
      result: "Safari is focused",
      structuredResult: '{\n  "focused": true\n}',
      error: "partial metadata unavailable",
      durationMs: 2_500,
    });
  });

  it("renders dynamic-tool namespace, arguments, returned content, and success", () => {
    const details = deriveWorkLogToolDetails({
      label: "Tool call",
      itemType: "dynamic_tool_call",
      payload: {
        data: {
          item: {
            type: "dynamicToolCall",
            namespace: "workspace",
            tool: "lookup_symbol",
            arguments: { symbol: "renderTool" },
            contentItems: [{ type: "text", text: "src/render.ts:42" }],
            success: true,
            durationMs: 37,
          },
        },
      },
    });
    expect(details).toMatchObject({
      kind: "tool-call",
      namespace: "workspace",
      tool: "lookup_symbol",
      arguments: '{\n  "symbol": "renderTool"\n}',
      result: "src/render.ts:42",
      success: true,
      durationMs: 37,
    });
  });
});
