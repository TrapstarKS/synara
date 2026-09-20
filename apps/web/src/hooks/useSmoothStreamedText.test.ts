// FILE: useSmoothStreamedText.test.ts
// Purpose: Pins the pure reveal stepper — velocity-driven drain plus quantized commits.
//          The hook itself is thin wiring (refs + rAF scheduling) around this function.

import { describe, expect, it } from "vitest";

import {
  createSmoothRevealState,
  MIN_EMIT_INTERVAL_MS,
  stepSmoothReveal,
  streamedTextPrefix,
  type SmoothRevealState,
} from "./useSmoothStreamedText";

const FRAME_MS = 8; // ~120Hz display

interface DrainRun {
  emits: { at: number; count: number }[];
  frames: number;
  state: SmoothRevealState;
}

/** Drive the stepper frame-by-frame until the backlog drains (or maxFrames). */
function drain(
  state: SmoothRevealState,
  targetLength: number,
  startMs: number,
  maxFrames = 10_000,
): DrainRun {
  const emits: { at: number; count: number }[] = [];
  let emitted = Math.floor(state.shown);
  let now = startMs;
  let frames = 0;
  for (; frames < maxFrames; frames += 1) {
    const step = stepSmoothReveal(state, now, targetLength, emitted);
    if (step.emitCount !== null) {
      emits.push({ at: now, count: step.emitCount });
      emitted = step.emitCount;
    }
    if (step.done) {
      break;
    }
    now += FRAME_MS;
  }
  return { emits, frames, state };
}

describe("stepSmoothReveal", () => {
  it("spaces commits at least MIN_EMIT_INTERVAL_MS apart while draining", () => {
    const run = drain(createSmoothRevealState(0), 400, 1_000);

    expect(run.emits.length).toBeGreaterThan(1);
    for (let index = 1; index < run.emits.length - 1; index += 1) {
      expect(run.emits[index]!.at - run.emits[index - 1]!.at).toBeGreaterThanOrEqual(
        MIN_EMIT_INTERVAL_MS,
      );
    }
    // Quantization is the point: far fewer commits than frames.
    expect(run.emits.length).toBeLessThan(run.frames / 3);
  });

  it("reveals every character: the final commit is the full target length", () => {
    const run = drain(createSmoothRevealState(0), 137, 500);

    expect(run.emits.at(-1)?.count).toBe(137);
    expect(run.state.shown).toBe(137);
  });

  it("emits the catch-up commit even when the interval has not elapsed", () => {
    // Mid-burst, one frame from catching up, with a commit only 4ms ago: the
    // final characters must not be held hostage to the quantization gate.
    const state: SmoothRevealState = {
      shown: 101.5,
      velocity: 500,
      lastFrameAt: 992,
      lastEmitAt: 996,
    };
    const step = stepSmoothReveal(state, 1_000, 103, 101);

    expect(step.emitCount).toBe(103);
    expect(step.done).toBe(true);
  });

  it("shows received text immediately after a background-tab resume", () => {
    const state = createSmoothRevealState(0);
    // Prime one frame so velocity builds, then jump far ahead as if rAF was paused.
    stepSmoothReveal(state, 1_000, 500, 0);
    stepSmoothReveal(state, 1_008, 500, 0);
    const step = stepSmoothReveal(state, 61_000, 500, Math.floor(state.shown));
    expect(step).toEqual({ emitCount: 500, done: true });
    expect(state.shown).toBe(500);
  });

  it("clamps and sleeps when the target shrank below the revealed count", () => {
    const state = createSmoothRevealState(200);
    const step = stepSmoothReveal(state, 1_000, 50, 200);

    expect(state.shown).toBe(50);
    expect(step.done).toBe(true);
    expect(step.emitCount).toBeNull();
  });

  it("reports done and resets burst tracking once caught up", () => {
    const run = drain(createSmoothRevealState(0), 60, 2_000);

    expect(run.state.velocity).toBe(0);
    expect(run.state.lastFrameAt).toBe(0);
    // A later burst starting fresh emits its first advanced frame promptly.
    const next = drain(run.state, 120, 2_000 + run.frames * FRAME_MS + 100);
    expect(next.emits.length).toBeGreaterThan(0);
  });

  it("bounds the delay of a large flush instead of replaying seconds of artificial typing", () => {
    const run = drain(createSmoothRevealState(0), 10_000, 0);

    expect(run.frames * FRAME_MS).toBeLessThan(1_000);
    expect(run.emits[0]!.count).toBeGreaterThanOrEqual(9_680);
    expect(run.emits.at(-1)?.count).toBe(10_000);
  });

  it.each([1, 2, 10, 100])("finishes a %i-character burst without a fractional tail", (length) => {
    const run = drain(createSmoothRevealState(0), length, 1_000);
    expect(run.emits.at(-1)?.count).toBe(length);
    expect(run.frames * FRAME_MS).toBeLessThan(1_000);
  });

  it("keeps up with repeated large arrivals without losing or repeating text", () => {
    const state = createSmoothRevealState(0);
    let emitted = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      const target = (Math.floor(frame / 12) + 1) * 1_000;
      const step = stepSmoothReveal(state, 1_000 + frame * FRAME_MS, target, emitted);
      if (step.emitCount !== null) {
        expect(step.emitCount).toBeGreaterThanOrEqual(emitted);
        expect(step.emitCount).toBeLessThanOrEqual(target);
        emitted = step.emitCount;
      }
      expect(target - state.shown).toBeLessThanOrEqual(320);
    }
    expect(drain(state, 10_000, 1_960).emits.at(-1)?.count).toBe(10_000);
  });
});

describe("streamedTextPrefix", () => {
  it("reveals Unicode code points intact and preserves the exact final text", () => {
    const text = "Olá 👩🏽‍💻!\n```lua\nprint('🚀')\n```";
    for (let count = 0; count <= text.length; count += 1) {
      const prefix = streamedTextPrefix(text, count);
      expect(text.startsWith(prefix)).toBe(true);
      expect(prefix).not.toMatch(/[\uD800-\uDFFF]/u);
      expect(prefix.length).toBeLessThanOrEqual(count);
    }
    expect(streamedTextPrefix(text, text.length)).toBe(text);
  });
});
