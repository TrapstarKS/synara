import "../../index.css";
import { MessageId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ChatMessage } from "../../types";
import { ComposerAsyncUserInputPanel } from "./ComposerAsyncUserInputPanel";

describe("ComposerAsyncUserInputPanel", () => {
  it("keeps questions accessible as new output arrives and preserves the ordinary composer", async () => {
    const question: ChatMessage = {
      id: MessageId.makeUnsafe("composer-question"),
      role: "assistant",
      text: "More context?",
      createdAt: "2026-09-19T00:00:00.000Z",
      streaming: false,
      source: "native",
      asyncUserInput: { questions: [{ title: "Which project?" }] },
    };
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const view = (messages: ChatMessage[]) => (
      <>
        <ComposerAsyncUserInputPanel
          threadId="chat-panel"
          messages={messages}
          onRespond={onRespond}
        />
        <textarea aria-label="Conversation composer" />
      </>
    );
    const screen = await render(view([question]));
    await screen.getByRole("textbox", { name: "Conversation composer" }).fill("Keep working");
    const later: ChatMessage = {
      id: MessageId.makeUnsafe("later-output"),
      role: "assistant",
      createdAt: question.createdAt,
      text: "Working on the next file",
      streaming: true,
    };
    await screen.rerender(view([question, later]));
    await screen.getByRole("button", { name: "1 question awaits your answer" }).click();
    await screen.getByRole("textbox", { name: "Answer: Which project?" }).fill("Synara");
    await screen.getByRole("button", { name: "Send answer" }).click();
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(question.id, ["Synara"]);
    await expect
      .element(screen.getByRole("textbox", { name: "Conversation composer" }))
      .toHaveValue("Keep working");
    await screen.rerender(
      view([
        {
          ...question,
          asyncUserInput: {
            ...question.asyncUserInput!,
            response: { messageId: MessageId.makeUnsafe("answer"), answers: ["Synara"] },
          },
        },
        { ...later, streaming: false },
      ]),
    );
    await expect
      .element(screen.getByRole("button", { name: "1 question awaits your answer" }))
      .not.toBeInTheDocument();
  });
});
