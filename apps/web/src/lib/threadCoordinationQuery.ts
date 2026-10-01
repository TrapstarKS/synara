import type { ThreadCoordinationListResult, ThreadId } from "@synara/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";

export const threadCoordinationQueryKey = ["thread-coordination"] as const;
const emptyCoordination: ThreadCoordinationListResult = {
  waits: [],
  questions: [],
  hasMore: false,
};

export function threadCoordinationQueryOptions(threadId?: ThreadId) {
  return queryOptions({
    queryKey: [...threadCoordinationQueryKey, threadId ?? null],
    queryFn: async () => {
      const api = ensureNativeApi().coordination;
      return api ? api.list(threadId ? { threadId } : {}) : emptyCoordination;
    },
    staleTime: 2_000,
    retry: false,
    refetchInterval: (query) => (query.state.status === "error" ? false : 3_000),
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
  });
}

export function useThreadCoordination(threadId?: ThreadId, enabled = true) {
  return useQuery({ ...threadCoordinationQueryOptions(threadId), enabled });
}
