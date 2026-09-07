import { isDeepStrictEqual } from "node:util";

export interface NativeMcpCall {
  readonly callId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly arguments: unknown;
}

export interface NativeMcpCallAuthority {
  readonly turnId: string;
  readonly isActive: () => boolean;
}

/** The provider's trusted event stream admits calls; HTTP metadata only selects one. */
export function makeNativeMcpCalls() {
  const sessions = new Map<
    string,
    Map<string, NativeMcpCall & { consumed: boolean; active: boolean }>
  >();
  const activeTurns = new Map<string, Set<string>>();
  return {
    enable: (token: string) => {
      sessions.set(token, new Map());
      activeTurns.set(token, new Set());
    },
    startTurn: (token: string, turnId: string) => {
      activeTurns.get(token)?.add(turnId);
    },
    hasSession: (token: string) => sessions.has(token),
    start: (token: string, call: NativeMcpCall) => {
      const calls = sessions.get(token);
      if (!calls || !activeTurns.get(token)?.has(call.turnId) || calls.has(call.callId)) return;
      calls.set(call.callId, { ...call, consumed: false, active: true });
    },
    finish: (token: string, callId: string) => {
      const calls = sessions.get(token);
      const call = calls?.get(callId);
      // Keep only a small tombstone until the turn ends; tool arguments can be large.
      if (call) calls?.set(callId, { ...call, active: false, arguments: null });
    },
    cancelTurn: (token: string, turnId: string) => {
      activeTurns.get(token)?.delete(turnId);
      const calls = sessions.get(token);
      for (const [id, call] of calls ?? []) {
        if (call.turnId === turnId) calls?.delete(id);
      }
    },
    revoke: (token: string) => {
      sessions.delete(token);
      activeTurns.delete(token);
    },
    consume: (
      token: string,
      callId: string,
      toolName: string,
      args: unknown,
    ): NativeMcpCallAuthority | null => {
      const calls = sessions.get(token);
      const call = calls?.get(callId);
      if (
        !call ||
        !call.active ||
        call.consumed ||
        call.toolName !== toolName ||
        !isDeepStrictEqual(call.arguments, args)
      )
        return null;
      call.consumed = true;
      return {
        turnId: call.turnId,
        isActive: () => call.active && sessions.get(token) === calls && calls?.get(callId) === call,
      };
    },
  };
}

export type NativeMcpCalls = ReturnType<typeof makeNativeMcpCalls>;
