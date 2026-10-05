import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../serverSettings";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type ThreadTurnStartCommand,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeThreadAwaitGuard } from "../orchestration/threadAwaitGuard.ts";
import { OrchestrationCommandInternalError } from "../orchestration/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "../persistence/Layers/OrchestrationEventDeliveries.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProviderRuntimeEventRepositoryLive } from "../persistence/Layers/ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventDeliveryRepository,
  PROVIDER_COMMAND_REACTOR_CONSUMER,
} from "../persistence/Services/OrchestrationEventDeliveries.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import {
  ProviderRuntimeEventRepository,
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
} from "../persistence/Services/ProviderRuntimeEvents.ts";
import migration from "../persistence/Migrations/120_CoordinatorQuestions.ts";
import { makeAwaitRepository } from "./awaitRepository.ts";
import { makeAwaitThreads } from "./awaitThreads.ts";
import { makeAwaitedDispatch } from "./awaitedDispatch.ts";
import { makeCompletionRepository } from "./completionRepository.ts";
import { makeCoordinatorQuestions } from "./coordinatorQuestions.ts";
import {
  makeCoordinatorQuestionRepository,
  questionAnswerMessageId,
} from "./coordinatorQuestionRepository.ts";
import { GatewayToolError, type ToolContext } from "./toolRuntime.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function harness(children = 1) {
  const layer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
    Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "synara-coordinator-questions-" }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  disposers.push(() => runtime.dispose());
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const projectionTurns = await runtime.runPromise(Effect.service(ProjectionTurnRepository));
  const journal = await runtime.runPromise(Effect.service(ProviderRuntimeEventRepository));
  const deliveries = await runtime.runPromise(Effect.service(OrchestrationEventDeliveryRepository));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const waits = await runtime.runPromise(makeAwaitRepository);
  const repository = await runtime.runPromise(makeCoordinatorQuestionRepository);
  const completionRepository = await runtime.runPromise(makeCompletionRepository);
  const guard = await runtime.runPromise(makeThreadAwaitGuard);
  const deps = {
    orchestrationEngine: engine,
    snapshotQuery,
    projectionTurns,
    completionRepository,
  };
  let questions = await runtime.runPromise(makeCoordinatorQuestions(deps));
  let awaiting = await runtime.runPromise(makeAwaitThreads({ ...deps, coordination: questions }));
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  let clock = Date.now() - 10000;
  const now = () => new Date(++clock).toISOString();
  let nextCommand = 0;
  const commandId = () => CommandId.makeUnsafe(`fixture:${++nextCommand}`);
  const parent = ThreadId.makeUnsafe("coordinator");
  const executors = Array.from({ length: children }, (_, index) =>
    ThreadId.makeUnsafe(`executor-${index}`),
  );
  const source = (threadId: ThreadId) => TurnId.makeUnsafe(`${threadId}:source`);
  await run(
    engine.dispatch({
      type: "project.create",
      commandId: commandId(),
      projectId: ProjectId.makeUnsafe("project"),
      title: "Coordination",
      workspaceRoot: "/tmp/coordinator-questions",
      defaultModelSelection: null,
      createdAt: now(),
    }),
  );
  const settleDelivery = async (sequence: number, threadId: ThreadId) => {
    const claimOwner = `fixture:${sequence}`;
    await run(
      deliveries.claim({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        threadId,
        claimOwner,
        claimedAt: now(),
        claimExpiresAt: now(),
      }),
    );
    await run(
      deliveries.complete({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: sequence,
        claimOwner,
        completedAt: now(),
      }),
    );
  };
  const setSession = (
    threadId: ThreadId,
    turnId: TurnId | null,
    status: "running" | "ready" | "stopped" | "interrupted",
  ) => {
    const createdAt = now();
    return run(
      engine.dispatch({
        type: "thread.session.set",
        commandId: commandId(),
        threadId,
        session: {
          threadId,
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          status,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
  };
  for (const threadId of [parent, ...executors]) {
    await run(
      engine.dispatch({
        type: "thread.create",
        commandId: commandId(),
        threadId,
        projectId: ProjectId.makeUnsafe("project"),
        title: threadId,
        modelSelection: { provider: "codex", model: "test-model" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now(),
      }),
    );
    const accepted = await run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: commandId(),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe(`${threadId}:initial`),
          role: "user",
          text: "Complete the delegated task",
          attachments: [],
        },
        dispatchMode: "queue",
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: now(),
      }),
    );
    await settleDelivery(accepted.sequence, threadId);
    await setSession(threadId, source(threadId), "running");
  }
  const registeredSequence = await run(engine.getEventHighWaterSequence);
  await run(
    waits.reserve({
      waitId: "delegation",
      callerThreadId: parent,
      callerTurnId: source(parent),
      registeredSequence,
      createdAt: now(),
      requestJson: JSON.stringify({ threadIds: executors, runIds: executors.map(source) }),
      targetsJson: JSON.stringify(
        executors.map((threadId) => ({
          pin: { threadId, runId: source(threadId), messageId: `${threadId}:initial` },
          result: null,
        })),
      ),
    }),
  );
  const context = (threadId: ThreadId, turnId: TurnId): ToolContext => ({
    principal: {
      kind: "provider-session",
      threadId,
      turnId,
      provider: "codex",
      sessionKey: "fixture",
    },
    callerThreadId: threadId,
    callerTurnId: turnId,
    callerThreadLabel: null,
    callerProvider: "codex",
    callerSessionKey: "fixture",
    jsonRpcRequestId: "test",
    callerCapabilities: new Set(["thread:read", "thread:write"]),
    assertCallerTurnActive: () =>
      snapshotQuery.getThreadShellById(threadId).pipe(
        Effect.mapError((error) => new GatewayToolError("caller_turn_inactive", error.message)),
        Effect.flatMap((shell) =>
          Option.isSome(shell) &&
          shell.value.session?.activeTurnId === turnId &&
          shell.value.session.status === "running"
            ? Effect.void
            : Effect.fail(
                new GatewayToolError("caller_turn_inactive", "Fixture turn is inactive."),
              ),
        ),
      ),
  });
  const call = async (
    name: string,
    args: Record<string, unknown>,
    threadId: ThreadId,
    turnId = source(threadId),
  ) => {
    const response = await run(
      questions.tools
        .find((tool) => tool.definition.name === name)!
        .handler(args, context(threadId, turnId)),
    );
    const data = JSON.parse((response.content[0] as { type: "text"; text: string }).text) as Record<
      string,
      unknown
    >;
    return { response, data };
  };
  const acknowledge = () =>
    run(
      journal.getHighWaterSequence.pipe(
        Effect.flatMap((throughSequence) =>
          journal.advanceConsumerCursorThrough({
            consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
            throughSequence,
            updatedAt: now(),
          }),
        ),
      ),
    );
  const finish = async (
    threadId: ThreadId,
    turnId = source(threadId),
    text = "Final task result",
    ack = true,
  ) => {
    await run(
      engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: commandId(),
        threadId,
        messageId: MessageId.makeUnsafe(`${turnId}:assistant`),
        turnId,
        delta: text,
        createdAt: now(),
      }),
    );
    await run(
      engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: commandId(),
        threadId,
        messageId: MessageId.makeUnsafe(`${turnId}:assistant`),
        turnId,
        createdAt: now(),
      }),
    );
    await setSession(threadId, null, "ready");
    await run(
      journal.append({
        type: "turn.completed",
        eventId: EventId.makeUnsafe(`${turnId}:terminal`),
        threadId,
        turnId,
        provider: "codex",
        createdAt: now(),
        payload: { state: "completed" },
      }),
    );
    if (ack) await acknowledge();
  };
  const starts = async (threadId?: ThreadId) =>
    run(sql<{
      command: string;
    }>`SELECT wait.dispatch_json AS command FROM agent_gateway_waits AS wait
    JOIN orchestration_command_receipts AS receipt ON receipt.command_id = json_extract(wait.dispatch_json, '$.commandId')
    WHERE receipt.status = 'accepted' AND (${threadId ?? null} IS NULL OR wait.caller_thread_id = ${threadId ?? null})
    ORDER BY receipt.result_sequence`).then((rows) =>
      rows.map((row) => JSON.parse(row.command) as typeof ThreadTurnStartCommand.Type),
    );
  const activate = async (command: typeof ThreadTurnStartCommand.Type, turnId: TurnId) => {
    const rows = await run(sql<{
      sequence: number;
    }>`SELECT sequence FROM orchestration_events WHERE command_id = ${command.commandId}
      AND event_type = 'thread.turn-start-requested' ORDER BY sequence DESC LIMIT 1`);
    await settleDelivery(rows[0]!.sequence, command.threadId);
    await setSession(command.threadId, turnId, "running");
  };
  const scan = async () => {
    await run(questions.deliverPending());
    await run(awaiting.deliverPending());
  };
  const reload = async () => {
    questions = await runtime.runPromise(makeCoordinatorQuestions(deps));
    awaiting = await runtime.runPromise(makeAwaitThreads({ ...deps, coordination: questions }));
  };
  const scanWithInterleavedQuestion = async (interleave: () => Promise<void>) => {
    let intervened = false;
    const scanner = await runtime.runPromise(
      makeAwaitThreads({
        ...deps,
        coordination: {
          ...questions,
          handleWaitDelivery: (row) =>
            questions.handleWaitDelivery(row).pipe(
              Effect.tap((handled) => {
                if (handled || intervened || row.waitId !== "delegation") return Effect.void;
                intervened = true;
                return Effect.promise(interleave);
              }),
            ),
        },
      }),
    );
    await run(scanner.deliverPending());
  };
  const dispatchTarget = engine as { dispatch: typeof engine.dispatch };
  const originalDispatch = engine.dispatch;
  const interceptDispatch = (
    interceptor: (command: OrchestrationCommand) => Effect.Effect<void>,
  ) => {
    dispatchTarget.dispatch = (command, context) =>
      interceptor(command).pipe(Effect.andThen(originalDispatch(command, context)));
  };
  const loseAnswerAcknowledgement = () => {
    let lose = true;
    dispatchTarget.dispatch = (command, context) =>
      originalDispatch(command, context).pipe(
        Effect.flatMap((result) => {
          if (
            lose &&
            command.type === "thread.turn.start" &&
            command.commandId.endsWith(":answer")
          ) {
            lose = false;
            return Effect.fail(
              new OrchestrationCommandInternalError({
                commandId: command.commandId,
                commandType: command.type,
                detail: "Lost acknowledgement after commit",
              }),
            );
          }
          return Effect.succeed(result);
        }),
      );
  };
  return {
    runtime,
    engine,
    snapshotQuery,
    sql,
    run,
    waits,
    repository,
    guard,
    parent,
    executors,
    source,
    now,
    commandId,
    call,
    finish,
    activate,
    starts,
    scan,
    reload,
    scanWithInterleavedQuestion,
    acknowledge,
    questions: () => questions,
    context,
    setSession,
    interceptDispatch,
    originalDispatch,
    loseAnswerAcknowledgement,
  };
}

describe("coordinator questions", () => {
  it("admits and replays an integrated awaited send through the real engine and exact queue projection", async () => {
    const h = await harness();
    const child = h.executors[0]!;
    const dispatches = await h.runtime.runPromise(
      makeAwaitedDispatch({ orchestrationEngine: h.engine, snapshotQuery: h.snapshotQuery }),
    );
    const target = Option.getOrThrow(await h.run(h.snapshotQuery.getThreadShellById(child)));
    const request = {
      requestId: "integrated-send",
      target,
      message: "Perform a second exact task.",
      scope: {
        callerThreadId: h.parent,
        callerTurnId: h.source(h.parent),
        registeredSequence: await h.run(h.engine.getEventHighWaterSequence),
        createdAt: h.now(),
      },
      assertAuthority: h.context(h.parent, h.source(h.parent)).assertCallerTurnActive,
    };
    const first = await h.run(dispatches.send(request));
    expect(await h.run(dispatches.send(request))).toEqual(first);
    const events = await h.run(h.sql<{
      messageId: string;
    }>`SELECT json_extract(payload_json, '$.messageId') AS messageId
      FROM orchestration_events WHERE stream_id = ${child} AND event_type = 'thread.turn-queued'
        AND json_extract(payload_json, '$.messageId') = ${first.messageId}`);
    expect(events).toEqual([{ messageId: first.messageId }]);
    const saved = await h.run(h.waits.getById(first.waitId));
    expect(
      JSON.parse(saved!.targetsJson).some(
        (entry: { pin: { messageId: string } }) => entry.pin.messageId === first.messageId,
      ),
    ).toBe(true);
  });

  it("rejects a saved delegation when cancellation wins after preflight but before engine commit", async () => {
    const h = await harness();
    const child = h.executors[0]!;
    const dispatches = await h.runtime.runPromise(
      makeAwaitedDispatch({ orchestrationEngine: h.engine, snapshotQuery: h.snapshotQuery }),
    );
    const target = Option.getOrThrow(await h.run(h.snapshotQuery.getThreadShellById(child)));
    h.interceptDispatch((command) =>
      command.type === "thread.turn.start" && command.awaitedDispatchId
        ? h.sql`UPDATE agent_gateway_waits SET state = 'cancelled' WHERE wait_id = 'delegation'`.pipe(
            Effect.asVoid,
            Effect.orDie,
          )
        : Effect.void,
    );
    await expect(
      h.run(
        dispatches.send({
          requestId: "cancelled-send",
          target,
          message: "Must not run after cancellation.",
          scope: {
            callerThreadId: h.parent,
            callerTurnId: h.source(h.parent),
            registeredSequence: await h.run(h.engine.getEventHighWaterSequence),
            createdAt: h.now(),
          },
          assertAuthority: h.context(h.parent, h.source(h.parent)).assertCallerTurnActive,
        }),
      ),
    ).rejects.toThrow("Awaited dispatch refused");
    expect(
      await h.run(h.sql`SELECT message_id FROM projection_thread_messages
      WHERE thread_id = ${child} AND text = 'Must not run after cancellation.'`),
    ).toEqual([]);
  });

  it.each(["privilege", "workspace"] as const)(
    "requires a human answer when the coordinator cannot drive the executor's %s",
    async (boundary) => {
      const h = await harness();
      const child = h.executors[0]!;
      const asked = await h.call(
        "synara_ask_coordinator",
        { requestId: "boundary", question: "Which scope should I use?" },
        child,
      );
      const questionId = asked.data.questionId as string;
      await h.finish(child);
      await h.finish(h.parent);
      await h.scan();
      const parentTurn = TurnId.makeUnsafe("coordinator:permission-boundary");
      await h.activate((await h.starts(h.parent))[0]!, parentTurn);
      if (boundary === "privilege") {
        await h.run(
          h.engine.dispatch({
            type: "thread.runtime-mode.set",
            commandId: h.commandId(),
            threadId: child,
            runtimeMode: "full-access",
            createdAt: h.now(),
          }),
        );
      } else {
        await h.run(
          h.sql`UPDATE projection_threads SET env_mode = 'worktree' WHERE thread_id = ${h.parent}`,
        );
      }
      const denied = await h.call(
        "synara_answer_question",
        { questionId, answer: "Proceed." },
        h.parent,
        parentTurn,
      );
      expect(denied.response.isError).toBe(true);
      expect(denied.data.error).toMatchObject({ code: "capability_denied" });
      expect((await h.run(h.repository.get(questionId)))?.answer).toBeNull();
      const escalated = await h.call(
        "synara_answer_question",
        { questionId, needsUser: true, reason: "Your decision is required." },
        h.parent,
        parentTurn,
      );
      expect(escalated.response.isError).not.toBe(true);
      expect(
        await h.run(
          h.questions().answerHuman({
            threadId: h.parent,
            questionId,
            answer: "Use the scope already assigned to this task.",
          }),
        ),
      ).toEqual({ accepted: true });
      await h.finish(h.parent, parentTurn);
      await h.scan();
      expect(await h.starts(child)).toHaveLength(1);
    },
  );

  it("revokes an automatic answer when executor privileges change after it was saved", async () => {
    const h = await harness();
    const child = h.executors[0]!;
    const questionId = (
      await h.call(
        "synara_ask_coordinator",
        { requestId: "change", question: "Which case?" },
        child,
      )
    ).data.questionId as string;
    await h.finish(child);
    await h.finish(h.parent);
    await h.scan();
    const parentTurn = TurnId.makeUnsafe("coordinator:changed-privileges");
    await h.activate((await h.starts(h.parent))[0]!, parentTurn);
    expect(
      (
        await h.call(
          "synara_answer_question",
          { questionId, answer: "Use the current case." },
          h.parent,
          parentTurn,
        )
      ).response.isError,
    ).not.toBe(true);
    await h.run(
      h.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: h.commandId(),
        threadId: child,
        runtimeMode: "full-access",
        createdAt: h.now(),
      }),
    );
    await h.finish(h.parent, parentTurn);
    await h.reload();
    await h.scan();
    expect(await h.starts(child)).toHaveLength(0);
    expect((await h.run(h.repository.get(questionId)))?.state).toBe("cancelled");
  });

  it("does not freeze a final result when a question arrives after the scan's initial hook", async () => {
    const h = await harness();
    const child = h.executors[0]!;
    await h.finish(h.parent);
    let questionId = "";
    await h.scanWithInterleavedQuestion(async () => {
      const asked = await h.call(
        "synara_ask_coordinator",
        { requestId: "late-question", question: "A question during the result scan?" },
        child,
      );
      expect(asked.response.isError).not.toBe(true);
      questionId = asked.data.questionId as string;
      await h.finish(child, h.source(child), "This is a question turn, not a final result");
    });
    const pending = await h.run(h.waits.getById("delegation"));
    expect(pending?.state).toBe("waiting");
    expect(pending?.dispatchJson).toBeNull();
    expect(await h.starts()).toHaveLength(0);
    await h.reload();
    await h.scan();
    const notification = (await h.starts(h.parent))[0]!;
    expect(notification.commandId).toBe("delegation:questions");
    expect(notification.message.text).toContain(questionId);
    expect(notification.message.text).not.toContain("This is a question turn, not a final result");
    const turn = TurnId.makeUnsafe("coordinator:interleaved-question");
    await h.activate(notification, turn);
    expect(
      (
        await h.call(
          "synara_answer_question",
          { questionId, answer: "Proceed with the current task." },
          h.parent,
          turn,
        )
      ).response.isError,
    ).not.toBe(true);
    const successor = await h.run(h.waits.getByScope(h.parent, turn));
    expect(JSON.parse(successor!.targetsJson)[0].result).toBeNull();
    expect(JSON.parse(successor!.targetsJson)[0].pin.messageId).toBe(
      questionAnswerMessageId(questionId),
    );
  });

  it("wakes with questions only after both source turns and output settle, then re-arms the final result", async () => {
    const h = await harness();
    const child = h.executors[0]!;
    const asked = await h.call(
      "synara_ask_coordinator",
      { requestId: "question", question: "Which test case should I use?" },
      child,
    );
    expect(asked.response.isError).not.toBe(true);
    const questionId = asked.data.questionId as string;
    await h.scan();
    expect(await h.starts()).toHaveLength(0);
    await h.finish(child, h.source(child), "Waiting for guidance, not finished");
    await h.finish(h.parent, h.source(h.parent), "Waiting", false);
    await h.scan();
    expect(await h.starts()).toHaveLength(0);
    await h.acknowledge();
    await h.scan();
    const notification = (await h.starts(h.parent))[0]!;
    expect(notification.message.text).toContain("not final task results");
    expect(notification.message.text).toContain(questionId);
    const coordinatorTurn = TurnId.makeUnsafe("coordinator:question-turn");
    await h.activate(notification, coordinatorTurn);
    const answered = await h.call(
      "synara_answer_question",
      { questionId, answer: "Use the cancellation regression." },
      h.parent,
      coordinatorTurn,
    );
    expect(answered.response.isError).not.toBe(true);
    const successor = await h.run(h.waits.getByScope(h.parent, coordinatorTurn));
    expect(JSON.parse(successor!.targetsJson)[0].pin).toEqual({
      threadId: child,
      runId: null,
      messageId: questionAnswerMessageId(questionId),
    });
    await h.scan();
    const reply = (await h.starts(child))[0]!;
    expect(reply.awaitPrecondition?.sourceTurnId).toBe(h.source(child));
    expect(reply.modelSelection).toBeUndefined();
    expect(reply.runtimeMode).toBe("approval-required");
    const executorTurn = TurnId.makeUnsafe("executor:answer-turn");
    await h.activate(reply, executorTurn);
    await h.finish(h.parent, coordinatorTurn, "Waiting for the actual result");
    await h.scan();
    expect(await h.starts(h.parent)).toHaveLength(1);
    await h.finish(child, executorTurn, "Cancellation regression passes");
    await h.scan();
    const final = (await h.starts(h.parent))[1]!;
    expect(final.message.text).toContain("Cancellation regression passes");
    expect(final.message.text).not.toContain("Waiting for guidance, not finished");
    await h.reload();
    await h.scan();
    expect(await h.starts(h.parent)).toHaveLength(2);
    expect(await h.starts(child)).toHaveLength(1);
  });

  it("binds recipients to exact runs and rejects overrides and duplicate conflicts", async () => {
    const h = await harness();
    const child = h.executors[0]!;
    expect(
      (
        await h.call(
          "synara_ask_coordinator",
          { requestId: "q", question: "Question", coordinatorThreadId: "other" },
          child,
        )
      ).response.isError,
    ).toBe(true);
    const first = await h.call(
      "synara_ask_coordinator",
      { requestId: "q", question: "Question" },
      child,
    );
    expect(
      (await h.call("synara_ask_coordinator", { requestId: "q", question: "Question" }, child))
        .data,
    ).toEqual(first.data);
    expect(
      (
        await h.call(
          "synara_ask_coordinator",
          { requestId: "different", question: "Question" },
          child,
        )
      ).response.isError,
    ).toBe(true);
    expect(
      (
        await h.call(
          "synara_ask_coordinator",
          { requestId: "q", question: "x".repeat(4001) },
          h.parent,
        )
      ).response.isError,
    ).toBe(true);
    expect(await h.run(h.questions().list({ threadId: child }))).toEqual([]);
    expect(await h.run(h.questions().list({ threadId: h.parent }))).toHaveLength(1);
    await h.run(migration.pipe(Effect.provideService(SqlClient.SqlClient, h.sql)));
    expect(await h.run(h.repository.get(first.data.questionId as string))).not.toBeNull();
  });

  it("keeps a second question round attached to the new executor run and never repeats the first answer", async () => {
    const h = await harness();
    const child = h.executors[0]!;
    let childTurn = h.source(child);
    let parentTurn = h.source(h.parent);
    for (let round = 0; round < 2; round++) {
      const questionId = (
        await h.call(
          "synara_ask_coordinator",
          { requestId: `round-${round}`, question: `Question ${round}?` },
          child,
          childTurn,
        )
      ).data.questionId as string;
      expect(questionId).toBeTruthy();
      await h.finish(child, childTurn, `Question ${round} awaiting answer`);
      await h.finish(h.parent, parentTurn, "Waiting for delegated work");
      await h.scan();
      const notification = (await h.starts(h.parent))[round]!;
      expect(notification.message.text).toContain(questionId);
      parentTurn = TurnId.makeUnsafe(`coordinator:round-${round}`);
      await h.activate(notification, parentTurn);
      expect(
        (
          await h.call(
            "synara_answer_question",
            { questionId, answer: `Answer ${round}` },
            h.parent,
            parentTurn,
          )
        ).response.isError,
      ).not.toBe(true);
      await h.scan();
      const reply = (await h.starts(child))[round]!;
      expect(reply.message.messageId).toBe(questionAnswerMessageId(questionId));
      expect(reply.awaitPrecondition?.sourceTurnId).toBe(childTurn);
      childTurn = TurnId.makeUnsafe(`executor:round-${round}`);
      await h.activate(reply, childTurn);
    }
    await h.finish(child, childTurn, "Actual final result after two questions");
    await h.finish(h.parent, parentTurn);
    await h.scan();
    expect((await h.starts(h.parent))[2]!.message.text).toContain(
      "Actual final result after two questions",
    );
    expect(await h.starts(child)).toHaveLength(2);
  });

  it("preserves existing manual wait bytes, unrelated targets, and source watermark when re-arming", async () => {
    const h = await harness(2);
    const [child, sibling] = h.executors as [ThreadId, ThreadId];
    const questionId = (
      await h.call("synara_ask_coordinator", { requestId: "q", question: "Question?" }, child)
    ).data.questionId as string;
    await h.finish(child);
    await h.finish(h.parent);
    await h.scan();
    const turn = TurnId.makeUnsafe("coordinator:manual-wait");
    await h.activate((await h.starts(h.parent))[0]!, turn);
    const previous = {
      waitId: "manual",
      callerThreadId: h.parent,
      callerTurnId: turn,
      requestJson: `{ "threadIds": ["${sibling}"], "runIds": ["${h.source(sibling)}"] }`,
      targetsJson: JSON.stringify([
        {
          pin: { threadId: sibling, runId: h.source(sibling), messageId: `${sibling}:initial` },
          result: null,
        },
      ]),
      registeredSequence: await h.run(h.engine.getEventHighWaterSequence),
      createdAt: h.now(),
    };
    await h.run(h.waits.reserve(previous));
    expect(
      (await h.call("synara_answer_question", { questionId, answer: "Answer" }, h.parent, turn))
        .response.isError,
    ).not.toBe(true);
    const saved = await h.run(h.waits.reserve(previous));
    expect(saved.requestJson).toBe(previous.requestJson);
    expect(saved.registeredSequence).toBe(previous.registeredSequence);
    expect(saved.waitId).toBe("manual");
    expect(JSON.parse(saved.targetsJson)).toHaveLength(2);
    await h.run(h.questions().cancelForWait({ threadId: h.parent, waitId: saved.waitId }));
    await h.scan();
    expect(await h.starts(child)).toHaveLength(0);
    expect((await h.run(h.repository.get(questionId)))?.state).toBe("cancelled");
  });

  it("recovers a lost answer acknowledgement from its existing receipt without dispatching twice", async () => {
    const h = await harness();
    const child = h.executors[0]!;
    const questionId = (
      await h.call("synara_ask_coordinator", { requestId: "q", question: "Question?" }, child)
    ).data.questionId as string;
    await h.finish(child);
    await h.finish(h.parent);
    await h.scan();
    const turn = TurnId.makeUnsafe("coordinator:lost-ack");
    await h.activate((await h.starts(h.parent))[0]!, turn);
    await h.call("synara_answer_question", { questionId, answer: "Frozen answer" }, h.parent, turn);
    h.loseAnswerAcknowledgement();
    await h.scan();
    expect((await h.run(h.repository.get(questionId)))?.state).toBe("answering");
    const frozen = (await h.starts(child))[0]!;
    await h.reload();
    await h.scan();
    expect(await h.starts(child)).toEqual([frozen]);
    expect((await h.run(h.repository.get(questionId)))?.state).toBe("answered");
  });

  it("revalidates coordinator ownership inside serialized admission after an answer was prepared", async () => {
    const h = await harness();
    const child = h.executors[0]!;
    const questionId = (
      await h.call("synara_ask_coordinator", { requestId: "q", question: "Question?" }, child)
    ).data.questionId as string;
    await h.finish(child);
    await h.finish(h.parent);
    await h.scan();
    const turn = TurnId.makeUnsafe("coordinator:admission-race");
    await h.activate((await h.starts(h.parent))[0]!, turn);
    await h.call("synara_answer_question", { questionId, answer: "Answer" }, h.parent, turn);
    let revoked = false;
    h.interceptDispatch((command) => {
      if (revoked || command.type !== "thread.turn.start" || command.threadId !== child)
        return Effect.void;
      revoked = true;
      return h
        .originalDispatch({
          type: "thread.turn.interrupt",
          commandId: h.commandId(),
          threadId: h.parent,
          turnId: turn,
          createdAt: h.now(),
        })
        .pipe(Effect.asVoid, Effect.orDie);
    });
    await h.scan();
    expect(revoked).toBe(true);
    expect(await h.starts(child)).toHaveLength(0);
    expect((await h.run(h.repository.get(questionId)))?.state).toBe("cancelled");
  });

  it("escalates an unanswered completed coordinator turn once without issuing another coordinator turn", async () => {
    const h = await harness();
    const child = h.executors[0]!;
    const questionId = (
      await h.call("synara_ask_coordinator", { requestId: "q", question: "Need a decision" }, child)
    ).data.questionId as string;
    await h.finish(child);
    await h.finish(h.parent);
    await h.scan();
    const turn = TurnId.makeUnsafe("coordinator:unanswered");
    await h.activate((await h.starts(h.parent))[0]!, turn);
    await h.finish(h.parent, turn, "I need the user to decide.");
    expect(await h.run(h.guard.hasPending(h.parent))).toBe(true);
    await h.scan();
    await h.reload();
    await h.scan();
    const question = await h.run(h.repository.get(questionId));
    expect(question?.state).toBe("human");
    expect(question?.rearmedWaitId).toBeTruthy();
    expect(await h.starts(h.parent)).toHaveLength(1);
    expect(
      await h.run(
        h
          .questions()
          .answerHuman({ threadId: h.parent, questionId, answer: "Use the existing behavior." }),
      ),
    ).toEqual({ accepted: true });
    await h.scan();
    expect(await h.starts(child)).toHaveLength(1);
  });

  it("batches questions and permits multiple answers in one coordinator turn without losing sibling pins", async () => {
    const h = await harness(3);
    const [a, b, sibling] = h.executors as [ThreadId, ThreadId, ThreadId];
    const qa = (await h.call("synara_ask_coordinator", { requestId: "a", question: "A?" }, a)).data
      .questionId as string;
    const qb = (await h.call("synara_ask_coordinator", { requestId: "b", question: "B?" }, b)).data
      .questionId as string;
    await h.finish(a);
    await h.finish(b);
    await h.finish(h.parent);
    await h.scan();
    const notification = (await h.starts(h.parent))[0]!;
    expect(notification.message.text).toContain(qa);
    expect(notification.message.text).toContain(qb);
    const turn = TurnId.makeUnsafe("coordinator:batch");
    await h.activate(notification, turn);
    expect(
      (
        await h.call(
          "synara_answer_question",
          { questionId: qa, answer: "A answer" },
          h.parent,
          turn,
        )
      ).response.isError,
    ).not.toBe(true);
    expect(
      (
        await h.call(
          "synara_answer_question",
          { questionId: qb, answer: "B answer" },
          h.parent,
          turn,
        )
      ).response.isError,
    ).not.toBe(true);
    const successor = await h.run(h.waits.getByScope(h.parent, turn));
    const targets = JSON.parse(successor!.targetsJson);
    expect(targets).toHaveLength(3);
    expect(
      targets.find((entry: { pin: { threadId: string } }) => entry.pin.threadId === sibling).pin
        .runId,
    ).toBe(h.source(sibling));
    await h.scan();
    expect(await h.starts(a)).toHaveLength(1);
    expect(await h.starts(b)).toHaveLength(1);
    expect(await h.starts(h.parent)).toHaveLength(1);
  });

  it("escalates in the main conversation, accepts the matching human answer once, and preserves native approvals", async () => {
    const h = await harness();
    const child = h.executors[0]!;
    const questionId = (
      await h.call(
        "synara_ask_coordinator",
        { requestId: "decision", question: "Which behavior does the user prefer?" },
        child,
      )
    ).data.questionId as string;
    await h.finish(child);
    await h.finish(h.parent);
    await h.scan();
    const turn = TurnId.makeUnsafe("coordinator:human-decision");
    await h.activate((await h.starts(h.parent))[0]!, turn);
    const escalated = await h.call(
      "synara_answer_question",
      { questionId, needsUser: true, reason: "This changes the requested behavior." },
      h.parent,
      turn,
    );
    expect(escalated.response.isError).not.toBe(true);
    await h.finish(h.parent, turn);
    await h.scan();
    await h.reload();
    expect((await h.run(h.questions().list({ threadId: h.parent })))[0]?.state).toBe("human");
    expect(
      await h.run(
        h.questions().answerHuman({ threadId: child, questionId, answer: "Wrong recipient" }),
      ),
    ).toEqual({ accepted: false });
    await h.run(h.sql`INSERT INTO projection_pending_interactions (interaction_kind, request_id, thread_id, turn_id, status, created_at)
      VALUES ('approval', 'native-approval', ${child}, ${h.source(child)}, 'pending', ${h.now()})`);
    expect(
      await h.run(
        h
          .questions()
          .answerHuman({ threadId: h.parent, questionId, answer: "Keep the current behavior." }),
      ),
    ).toEqual({ accepted: true });
    expect(
      await h.run(
        h.questions().answerHuman({ threadId: h.parent, questionId, answer: "Conflicting answer" }),
      ),
    ).toEqual({ accepted: false });
    await h.scan();
    expect(await h.starts(child)).toHaveLength(0);
    expect(
      (
        await h.run(
          h.sql<{
            status: string;
          }>`SELECT status FROM projection_pending_interactions WHERE request_id = 'native-approval'`,
        )
      )[0]?.status,
    ).toBe("pending");
    await h.run(
      h.sql`UPDATE projection_pending_interactions SET status = 'confirmed' WHERE request_id = 'native-approval'`,
    );
    await h.scan();
    expect(await h.starts(child)).toHaveLength(1);
    expect((await h.starts(child))[0]!.message.text).toContain('"answerSource":"human"');
  });

  it.each(["stop", "archive", "new-user-message", "cancel-wait"] as const)(
    "revokes prepared executor answers after coordinator %s",
    async (action) => {
      const h = await harness();
      const child = h.executors[0]!;
      const questionId = (
        await h.call("synara_ask_coordinator", { requestId: "q", question: "Question?" }, child)
      ).data.questionId as string;
      await h.finish(child);
      await h.finish(h.parent);
      await h.scan();
      const turn = TurnId.makeUnsafe("coordinator:cancel");
      await h.activate((await h.starts(h.parent))[0]!, turn);
      expect(
        (await h.call("synara_answer_question", { questionId, answer: "Answer" }, h.parent, turn))
          .response.isError,
      ).not.toBe(true);
      const successor = (await h.run(h.waits.getByScope(h.parent, turn)))!;
      if (action === "cancel-wait")
        await h.run(h.questions().cancelForWait({ threadId: h.parent, waitId: successor.waitId }));
      else if (action === "stop")
        await h.run(
          h.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: h.commandId(),
            threadId: h.parent,
            turnId: turn,
            createdAt: h.now(),
          }),
        );
      else if (action === "archive")
        await h.run(
          h.engine.dispatch({
            type: "thread.archive",
            commandId: h.commandId(),
            threadId: h.parent,
          }),
        );
      else
        await h.run(
          h.engine.dispatch({
            type: "thread.turn.start",
            commandId: h.commandId(),
            threadId: h.parent,
            message: {
              messageId: MessageId.makeUnsafe("human-takes-over"),
              role: "user",
              text: "Do something else",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: h.now(),
          }),
        );
      await h.reload();
      await h.scan();
      expect(await h.starts(child)).toHaveLength(0);
      expect((await h.run(h.repository.get(questionId)))?.state).toBe("cancelled");
    },
  );
});
