import { create } from "zustand";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";

export type AsyncQuestionDraft = {
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  submittedAnswers?: readonly string[];
};

export function asyncQuestionDraftKey(threadId: string, messageId: string): string {
  return JSON.stringify([threadId, messageId]);
}

// The transcript and composer are two views of one answer. Keep edits through
// collapsing panels and navigating chats, and claim submission across both views.
export const useAsyncUserInputDraftStore = create<{
  drafts: Record<string, AsyncQuestionDraft>;
  inFlight: ReadonlySet<string>;
  setDraft: (key: string, draft: AsyncQuestionDraft) => void;
  clearDraft: (key: string) => void;
  claim: (key: string) => boolean;
  release: (key: string) => void;
}>((set, get) => ({
  drafts: {},
  inFlight: new Set(),
  setDraft: (key, draft) => set((state) => ({ drafts: { ...state.drafts, [key]: draft } })),
  clearDraft: (key) => {
    if (!(key in get().drafts)) return;
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[key];
      return { drafts };
    });
  },
  claim: (key) => {
    if (get().inFlight.has(key)) return false;
    set((state) => ({ inFlight: new Set([...state.inFlight, key]) }));
    return true;
  },
  release: (key) =>
    set((state) => {
      const inFlight = new Set(state.inFlight);
      inFlight.delete(key);
      return { inFlight };
    }),
}));
