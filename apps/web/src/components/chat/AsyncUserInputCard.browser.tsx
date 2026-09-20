import "../../index.css";
import { MessageId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import { AsyncUserInputCard } from "./AsyncUserInputCard";
import { useAsyncUserInputDraftStore } from "./asyncUserInputDraftStore";

const messageId = MessageId.makeUnsafe("async-question");
const input = {
  questions: [
    { title: "When does the bug happen?", options: ["On launch", "On reconnect"] },
    { title: "Any other details?" },
  ],
};

describe("AsyncUserInputCard", () => {
  afterEach(() => useAsyncUserInputDraftStore.setState({ drafts: {}, inFlight: new Set() }));

  it("clears a shared draft when the server acknowledgement precedes the submission response", async () => {
    let accept!: () => void;
    const onRespond = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const draftKey = "accepted-before-rpc";
    const props = {
      messageId,
      input: { questions: [{ title: "Which branch?" }] },
      draftKey,
      defaultOpen: true,
      onRespond,
    };
    const screen = await render(<AsyncUserInputCard {...props} />);
    await screen.getByRole("textbox").fill("main");
    await screen.getByRole("button", { name: "Send answer" }).click();
    await screen.rerender(
      <AsyncUserInputCard
        {...props}
        input={{
          ...props.input,
          response: { messageId: MessageId.makeUnsafe("accepted-answer"), answers: ["main"] },
        }}
      />,
    );
    await expect.element(screen.getByText("Answered", { exact: true })).toBeVisible();
    accept();
    await expect
      .poll(() => useAsyncUserInputDraftStore.getState().inFlight.has(draftKey))
      .toBe(false);
    await expect
      .poll(() => useAsyncUserInputDraftStore.getState().drafts[draftKey])
      .toBeUndefined();
  });

  it("shares drafts and prevents duplicate delivery between composer and transcript", async () => {
    let accept!: () => void;
    const onRespond = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const props = {
      messageId,
      input: { questions: [{ title: "Which branch?" }] },
      onRespond,
      draftKey: "shared-question",
      defaultOpen: true,
    };
    const screen = await render(
      <>
        <AsyncUserInputCard {...props} />
        <AsyncUserInputCard {...props} />
      </>,
    );
    await screen.getByRole("textbox", { name: "Answer: Which branch?" }).nth(0).fill("main");
    await expect
      .element(screen.getByRole("textbox", { name: "Answer: Which branch?" }).nth(1))
      .toHaveValue("main");
    await screen.getByRole("button", { name: "Send answer" }).nth(0).click();
    await expect.element(screen.getByRole("button", { name: "Submitting…" }).nth(1)).toBeDisabled();
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(messageId, ["main"]);
    accept();
    await expect.element(screen.getByText("Answered", { exact: true }).nth(1)).toBeVisible();
  });

  it("restores an unfinished draft when returning to the chat", async () => {
    const props = {
      messageId,
      input: { questions: [{ title: "Details?" }] },
      onRespond: vi.fn(),
      draftKey: "navigation-question",
      defaultOpen: true,
    };
    const screen = await render(<AsyncUserInputCard {...props} />);
    await screen.getByRole("textbox").fill("It fails after reconnecting");
    await screen.rerender(<div>Another chat</div>);
    await screen.rerender(<AsyncUserInputCard {...props} />);
    await expect.element(screen.getByRole("textbox")).toHaveValue("It fails after reconnecting");
  });

  it("requires an explicit submission, allows free text, and prevents double clicks", async () => {
    let accept!: () => void;
    const onRespond = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const screen = await render(
      <div className="max-w-xl p-4">
        <AsyncUserInputCard messageId={messageId} input={input} onRespond={onRespond} />
        <textarea aria-label="Conversation composer" />
      </div>,
    );
    const capsule = screen.getByRole("button", { name: "2 questions", exact: true });
    await expect.element(capsule).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByRole("form")).not.toBeInTheDocument();
    await capsule.click();
    await expect
      .element(screen.getByRole("button", { name: /On launch/ }))
      .toHaveAttribute("aria-pressed", "true");
    expect(onRespond).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: /On reconnect/ }).click();
    await screen.getByRole("button", { name: "Next", exact: true }).click();
    await expect.element(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
    await screen
      .getByRole("textbox", { name: "Answer: Any other details?" })
      .fill("Only after waking from sleep");
    await screen
      .getByRole("textbox", { name: "Conversation composer" })
      .fill("Keep checking the logs.");
    await capsule.click();
    await expect.element(capsule).toHaveAttribute("aria-expanded", "false");
    await capsule.click();
    await expect
      .element(screen.getByRole("textbox", { name: "Answer: Any other details?" }))
      .toHaveValue("Only after waking from sleep");
    await screen.getByRole("button", { name: "Previous question" }).click();
    await expect
      .element(screen.getByRole("button", { name: /On reconnect/ }))
      .toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("button", { name: "Next", exact: true }).click();
    await screen.getByRole("button", { name: "Send answer" }).click();
    await expect.element(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(messageId, [
      "On reconnect",
      "Only after waking from sleep",
    ]);
    accept();
    await expect.element(screen.getByText("Answered", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("textbox", { name: "Conversation composer" }))
      .toHaveValue("Keep checking the logs.");
  });

  it("restores an answered card and keeps rejected submissions editable", async () => {
    const onRespond = vi.fn().mockRejectedValue(new Error("Connection interrupted"));
    const screen = await render(
      <AsyncUserInputCard
        messageId={messageId}
        input={{ questions: [{ title: "More details?" }] }}
        onRespond={onRespond}
      />,
    );
    await screen.getByRole("button", { name: "1 question", exact: true }).click();
    await screen.getByRole("textbox").fill("Custom answer");
    await screen.getByRole("button", { name: "Send answer" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Connection interrupted");
    await expect.element(screen.getByRole("textbox")).toHaveValue("Custom answer");
    await screen.rerender(
      <AsyncUserInputCard
        messageId={messageId}
        input={{
          questions: [{ title: "More details?" }],
          response: { messageId: MessageId.makeUnsafe("answer"), answers: ["Answered elsewhere"] },
        }}
        onRespond={onRespond}
      />,
    );
    await expect.element(screen.getByText("Answered elsewhere")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Send answer" }))
      .not.toBeInTheDocument();
  });

  it("keeps shortcuts local to the opened question and never submits a suggested choice", async () => {
    const onRespond = vi.fn();
    const screen = await render(
      <div>
        <AsyncUserInputCard
          messageId={messageId}
          input={{ questions: [{ title: "First?", options: ["Alpha", "Beta"] }] }}
          onRespond={onRespond}
        />
        <AsyncUserInputCard
          messageId={MessageId.makeUnsafe("second")}
          input={{ questions: [{ title: "Second?", options: ["Gamma", "Delta"] }] }}
          onRespond={onRespond}
        />
        <textarea aria-label="Conversation composer" />
      </div>,
    );
    await screen.getByRole("button", { name: "1 question", exact: true }).nth(0).click();
    await screen.getByRole("button", { name: "1 question", exact: true }).nth(1).click();
    await screen.getByRole("button", { name: /Alpha/ }).click();
    await userEvent.keyboard("2");
    await expect
      .element(screen.getByRole("button", { name: /Beta/ }))
      .toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByRole("button", { name: /Gamma/ }))
      .toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("textbox", { name: "Conversation composer" }).fill("123");
    await expect
      .element(screen.getByRole("button", { name: /Beta/ }))
      .toHaveAttribute("aria-pressed", "true");
    expect(onRespond).not.toHaveBeenCalled();
  });
});
