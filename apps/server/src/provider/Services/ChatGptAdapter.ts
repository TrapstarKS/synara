/** ChatGPT (Web) implementation of the generic provider adapter contract. */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ChatGptAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "chatgpt";
}

export class ChatGptAdapter extends ServiceMap.Service<ChatGptAdapter, ChatGptAdapterShape>()(
  "synara/provider/Services/ChatGptAdapter",
) {}
