import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import { childTranscriptPreview } from "./SynaraThreadCreationCard";

const msg = (id: string, role: ChatMessage["role"], text: string) =>
  ({ id, role, text }) as unknown as ChatMessage;

describe("childTranscriptPreview", () => {
  it("keeps the last visible messages and drops system/empty rows", () => {
    const messages = [
      msg("s", "system", "sys"),
      ...Array.from({ length: 25 }, (_, i) => msg(`m${i}`, i % 2 ? "assistant" : "user", `t${i}`)),
      msg("e", "assistant", "  "),
    ];
    const recent = childTranscriptPreview(messages);
    expect(recent).toHaveLength(20);
    expect(recent[0]?.id).toBe("m5");
    expect(recent.at(-1)?.id).toBe("m24");
  });
});
