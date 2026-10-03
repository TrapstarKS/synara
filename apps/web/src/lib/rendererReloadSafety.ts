// Renderer-owned work must settle before an interface update destroys its promises.
// Running agent turns are server-owned and deliberately do not acquire this guard.
let pendingOperations = 0;
let reloadPending = false;
const reloadListeners = new Set<(pending: boolean) => void>();

export function onRendererReloadChange(listener: (pending: boolean) => void): () => void {
  reloadListeners.add(listener);
  return () => {
    reloadListeners.delete(listener);
  };
}

function notifyReloadChange(): void {
  for (const listener of reloadListeners) {
    try {
      listener(reloadPending);
    } catch (error) {
      console.error("Renderer reload observer failed", error);
    }
  }
}

export function isRendererReloadPending(): boolean {
  return reloadPending;
}

export function pendingRendererOperationCount(): number {
  return pendingOperations;
}

export function beginRendererOperation(): () => void {
  if (reloadPending) {
    throw new Error("The interface is reloading. Try again after it reconnects.");
  }
  pendingOperations += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    pendingOperations -= 1;
  };
}

export async function runRendererOperation<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const finish = beginRendererOperation();
  try {
    return await operation();
  } finally {
    finish();
  }
}

/** Held only after editor/draft persistence, until navigation or a rejected handoff. */
export function acquireRendererReload(): (() => void) | null {
  if (reloadPending || pendingOperations !== 0) return null;
  reloadPending = true;
  notifyReloadChange();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reloadPending = false;
    notifyReloadChange();
  };
}
