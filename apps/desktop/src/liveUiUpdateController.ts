// FILE: liveUiUpdateController.ts
// Purpose: Tries a verified interface generation without replacing its live runtime.
// Layer: Desktop update lifecycle; no backend/process shutdown dependencies.

import { randomUUID } from "node:crypto";
import type { DesktopInterfaceUpdateState } from "@synara/contracts";

export interface PreparedInterfaceUpdate {
  readonly dir: string;
  readonly version: string;
  readonly dispose: () => Promise<void>;
}

interface Candidate {
  readonly id: string;
  readonly update: PreparedInterfaceUpdate;
  readonly runtime: unknown;
}

interface Trial extends Candidate {
  readonly previous: PreparedInterfaceUpdate | null;
  readonly serverInstanceId: string;
  timer: ReturnType<typeof setTimeout> | null;
  failure: string | null;
}

export interface LiveUiUpdateDependencies {
  readonly currentVersion: string;
  readonly unsupportedReason: () => string | null;
  readonly runtimeIdentity: () => unknown;
  readonly prepare: (signal: AbortSignal) => Promise<PreparedInterfaceUpdate | null>;
  readonly classifyError: (error: unknown) => "restart-required" | "error";
  readonly reloadBlockedReason: () => string | null;
  /** A null root selects the bundled interface. Keep the previous root available for chunks. */
  readonly selectRoots: (current: string | null, previous: string | null) => void;
  readonly reload: () => void;
  readonly onState: (state: DesktopInterfaceUpdateState) => void;
  readonly confirmationTimeoutMs?: number;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The interface update could not be applied.";

/**
 * Preparation and activation are separate: downloading must not freeze editing,
 * and the renderer must flush its latest drafts immediately before activation.
 * Success is an exact-version acknowledgement from a hydrated replacement UI,
 * not the load event of an HTML document.
 */
export class LiveUiUpdateController {
  private state: DesktopInterfaceUpdateState;
  private preparing: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private candidate: Candidate | null = null;
  private trial: Trial | null = null;
  private current: PreparedInterfaceUpdate | null = null;
  private previous: PreparedInterfaceUpdate | null = null;
  private readonly failedUpdates = new Set<PreparedInterfaceUpdate>();
  private readonly rejectedVersions = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: LiveUiUpdateDependencies) {
    const unsupported = deps.unsupportedReason();
    this.state = {
      status: unsupported ? "unsupported" : "idle",
      currentVersion: deps.currentVersion,
      targetVersion: null,
      attemptId: null,
      message: unsupported,
    };
  }

  getState(): DesktopInterfaceUpdateState {
    return this.state;
  }

  refreshAvailability(): void {
    if (this.disposed || (this.state.status !== "unsupported" && this.state.status !== "idle"))
      return;
    const reason = this.deps.unsupportedReason();
    this.publish({ status: reason ? "unsupported" : "idle", message: reason });
  }

  isBusy(): boolean {
    // A failed trial deferred for a browser page must not prevent the user
    // from explicitly choosing the ordinary, confirmed full-app restart.
    return this.preparing !== null || (this.trial !== null && this.trial.failure === null);
  }

  private publish(patch: Partial<DesktopInterfaceUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  private retire(update: PreparedInterfaceUpdate | null): void {
    if (update) void update.dispose().catch(() => undefined);
  }

  async prepare(): Promise<void> {
    if (this.disposed) return;
    if (this.preparing) return this.preparing;
    if (this.trial) {
      if (this.trial.failure) this.rollback(this.trial.failure);
      return;
    }
    const unsupported = this.deps.unsupportedReason();
    if (unsupported) {
      this.publish({ status: "unsupported", message: unsupported });
      return;
    }
    if (this.candidate) {
      if (this.candidate.runtime === this.deps.runtimeIdentity()) {
        this.publish({ status: "ready", message: null });
        return;
      }
      this.retire(this.candidate.update);
      this.candidate = null;
    }
    const runtime = this.deps.runtimeIdentity();
    const abort = new AbortController();
    this.abort = abort;
    this.publish({ status: "preparing", targetVersion: null, attemptId: null, message: null });
    const preparation = (async () => {
      let update: PreparedInterfaceUpdate | null = null;
      try {
        update = await this.deps.prepare(abort.signal);
        if (this.disposed || abort.signal.aborted) {
          this.retire(update);
          return;
        }
        if (runtime !== this.deps.runtimeIdentity()) {
          this.retire(update);
          this.publish({
            status: "blocked",
            message:
              "The server changed while preparing the interface. Try again after it reconnects.",
          });
          return;
        }
        if (!update || update.version === this.state.currentVersion) {
          this.retire(update);
          this.publish({
            status: this.current ? "applied" : "idle",
            targetVersion: null,
            message: `The interface is already on ${this.state.currentVersion}.`,
          });
          return;
        }
        if (this.rejectedVersions.has(update.version)) {
          this.retire(update);
          this.publish({
            status: "restart-required",
            targetVersion: update.version,
            message:
              "This interface update failed its loading check. Use the full update when you are ready to restart.",
          });
          return;
        }
        this.candidate = { id: randomUUID(), update, runtime };
        this.publish({
          status: "ready",
          targetVersion: update.version,
          attemptId: this.candidate.id,
          message: null,
        });
      } catch (error) {
        this.retire(update);
        if (!this.disposed)
          this.publish({ status: this.deps.classifyError(error), message: messageOf(error) });
      }
    })();
    this.preparing = preparation;
    try {
      await preparation;
    } finally {
      if (this.preparing === preparation) this.preparing = null;
      if (this.abort === abort) this.abort = null;
    }
  }

  apply(input: { readonly attemptId: string; readonly serverInstanceId: string }): boolean {
    const candidate = this.candidate;
    if (
      this.disposed ||
      this.preparing ||
      this.trial ||
      !candidate ||
      candidate.id !== input.attemptId
    )
      return false;
    if (!input.serverInstanceId.trim() || candidate.runtime !== this.deps.runtimeIdentity()) {
      this.publish({
        status: "blocked",
        message: "Reconnect to the same server before reloading the interface.",
      });
      return false;
    }
    const blocked = this.deps.reloadBlockedReason();
    if (blocked) {
      this.publish({ status: "blocked", message: blocked });
      return false;
    }
    const trial: Trial = {
      ...candidate,
      previous: this.current,
      serverInstanceId: input.serverInstanceId,
      timer: null,
      failure: null,
    };
    this.candidate = null;
    this.trial = trial;
    this.publish({ status: "reloading", message: null });
    try {
      this.deps.selectRoots(trial.update.dir, trial.previous?.dir ?? null);
      trial.timer = setTimeout(() => {
        if (this.trial === trial)
          this.rollback("The new interface did not confirm a connection to the running server.");
      }, this.deps.confirmationTimeoutMs ?? 45_000);
      trial.timer.unref?.();
      this.deps.reload();
    } catch (error) {
      this.rollback(messageOf(error));
      return false;
    }
    return true;
  }

  confirm(input: {
    readonly attemptId: string;
    readonly version: string;
    readonly serverInstanceId: string;
  }): boolean {
    const trial = this.trial;
    if (
      this.disposed ||
      !trial ||
      trial.failure ||
      trial.id !== input.attemptId ||
      trial.update.version !== input.version ||
      trial.serverInstanceId !== input.serverInstanceId ||
      trial.runtime !== this.deps.runtimeIdentity()
    )
      return false;
    if (trial.timer) clearTimeout(trial.timer);
    this.trial = null;
    const obsolete = this.previous;
    this.previous = this.current;
    this.current = trial.update;
    this.publish({
      status: "applied",
      currentVersion: trial.update.version,
      targetVersion: trial.update.version,
      attemptId: null,
      message:
        "Interface updated. The app and agent runtime stay on their installed version until a full update.",
    });
    this.retire(obsolete);
    for (const failed of this.failedUpdates) this.retire(failed);
    this.failedUpdates.clear();
    return true;
  }

  /** Returns true when this failure belongs to an update trial, so crash recovery does not race it. */
  failLoading(message: string): boolean {
    if (!this.trial || this.disposed) return false;
    this.rollback(message);
    return true;
  }

  private rollback(message: string): void {
    const trial = this.trial;
    if (!trial || this.disposed) return;
    if (trial.timer) clearTimeout(trial.timer);
    trial.timer = null;
    trial.failure = message;
    this.rejectedVersions.add(trial.update.version);
    const blocked = this.deps.reloadBlockedReason();
    if (blocked) {
      // A page opened while the trial loaded must retain its DOM and tool refs.
      this.publish({ status: "blocked", message: `${message} Recovery is waiting: ${blocked}` });
      return;
    }
    this.trial = null;
    // Navigation is asynchronous and may even throw. Retain the failed
    // document's hashed chunks until a later healthy UI proves it is gone.
    this.failedUpdates.add(trial.update);
    this.deps.selectRoots(trial.previous?.dir ?? null, trial.update.dir);
    this.publish({
      status: "error",
      attemptId: null,
      message: `${message} Restored the previous interface; agents were not restarted.`,
    });
    try {
      this.deps.reload();
    } catch {
      // The previous root remains selected for the user's next Reload. Never
      // escalate a failed interface reload into quitting or stopping the server.
      this.publish({
        message: `${message} The previous interface is selected. Use View → Reload to reconnect it.`,
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    if (this.trial?.timer) clearTimeout(this.trial.timer);
    this.retire(this.candidate?.update ?? null);
    this.candidate = null;
    // Active roots are not removed here: a deferred quit can still have readers.
  }
}
