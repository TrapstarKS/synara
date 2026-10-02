// Real-driver regression over an owned AppKit NSOpenPanel/NSSavePanel target.
// Build the two observation/target binaries separately; this runner never builds,
// activates apps, uses AppleScript, touches the clipboard, or opens selected files.
// Example (all executable paths are explicit):
// node scripts/computer-use-fixtures/native-file-dialog-regression.mjs \
//   --driver /path/cua-driver --fixture /path/native-file-dialog-fixture \
//   --focus-probe /path/focus-probe --out /private/tmp/file-dialog-evidence \
//   --case open-sheet
// Omitting --case runs every case, stopping native input at the first failure.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const caseNames = [
  "reference-continuity",
  "open-sheet",
  "open-standalone",
  "save-sheet",
  "cancel-sheet",
  "parent-refusal",
];
const usage =
  "Usage: node native-file-dialog-regression.mjs --driver <binary> --fixture <binary> --focus-probe <binary> --out <directory> [--case reference-continuity|open-sheet|open-standalone|save-sheet|cancel-sheet|parent-refusal]";
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  assert.ok(
    ["--driver", "--fixture", "--focus-probe", "--out", "--case"].includes(key) &&
      value &&
      !value.startsWith("--") &&
      !(key in options),
    usage,
  );
  options[key] = value;
}
assert.equal(process.platform, "darwin", "This fixture requires macOS.");
for (const key of ["--driver", "--fixture", "--focus-probe", "--out"])
  assert.ok(options[key], usage);
if (options["--case"]) assert.ok(caseNames.includes(options["--case"]), usage);
const selectedCases = options["--case"] ? [options["--case"]] : caseNames;
const binaries = {};
for (const key of ["--driver", "--fixture", "--focus-probe"]) {
  assert.ok(isAbsolute(options[key]), `${key} must name an absolute executable path.`);
  binaries[key] = await realpath(options[key]);
  await access(binaries[key], constants.X_OK);
}
await mkdir(resolve(options["--out"]), { recursive: true });
const directory = await mkdtemp(join(resolve(options["--out"]), "native-file-dialog-"));
// A separate short socket path stays below macOS's Unix socket pathname limit.
const socketDirectory = await mkdtemp("/private/tmp/synara-fd-");
const socketPath = join(socketDirectory, "driver.sock");
const fixtureDirectory = join(directory, "owned files");
const selectionDirectory = join(fixtureDirectory, "Escolha com espaço Ω");
const openPath = join(selectionDirectory, "seleção café.txt");
const savePath = join(selectionDirectory, "saved selection café.txt");
const reportPath = join(directory, "report.json");
const report = {
  startedAt: new Date().toISOString(),
  directory,
  selectedCases,
  mode: "owned-native-driver-no-provider",
  cases: [],
  calls: [],
  observations: [],
  focusSamples: [],
  cleanup: [],
  passed: false,
};
const children = [];
const sockets = new Set();
const observedTokens = new Map();
let target,
  driver,
  sampler,
  baseline,
  latestFocus,
  focusReceivedAt = 0;
let interrupted,
  commandId = 0,
  nextRef = 0;
const normalized = (value) => String(value ?? "").normalize("NFC");
const windowIdOf = (window) => window.window_id ?? window.id;
const alive = (child) =>
  child &&
  Number.isInteger(child.pid) &&
  child.pid > 0 &&
  child.exitCode === null &&
  child.signalCode === null;
const focusFields = ["pid", "keyWin", "focusedPid", "space"];
const focusSample = (row) =>
  Object.fromEntries(["t", ...focusFields].map((key) => [key, row[key] ?? null]));

function launch(binary, args, extra = {}) {
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], ...extra });
  children.push(child);
  child.rows = [];
  child.diagnostics = "";
  child.on("error", (error) => {
    child.launchError = String(error);
  });
  child.stdin.on("error", (error) => {
    child.inputError = String(error);
  });
  child.stderr.on("data", (bytes) => {
    child.diagnostics = (child.diagnostics + bytes).slice(-16_384);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.length > 1_000_000) {
      child.protocolError = "Oversized fixture output.";
      interrupted ??= child.protocolError;
      return;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (child === sampler && typeof row.t === "number") {
      latestFocus = focusSample(row);
      focusReceivedAt = performance.now();
      report.focusSamples.push(latestFocus);
      if (row.app === "loginwindow") interrupted ??= "Desktop became locked.";
      if (baseline && focusFields.some((key) => latestFocus[key] !== baseline[key]))
        interrupted ??= "Focus or Space changed during the owned regression.";
    } else {
      child.rows.push(row);
      if (child.rows.length > 2_048) child.rows.shift();
    }
  });
  return child;
}

async function waitFor(read, description, timeout = 10_000, cleanup = false) {
  const until = performance.now() + timeout;
  do {
    if (!cleanup && interrupted) throw new Error(interrupted);
    const value = await read();
    if (value) return value;
    await delay(40);
  } while (performance.now() < until);
  throw new Error(`Timed out: ${description}`);
}

async function fixtureCommand(command, cleanup = false) {
  assert.ok(alive(target), target?.launchError ?? "Owned fixture exited.");
  const id = ++commandId;
  target.stdin.write(JSON.stringify({ id, command }) + "\n");
  const row = await waitFor(
    () => {
      assert.ok(alive(target), target?.launchError ?? "Owned fixture exited.");
      return target.rows.find((entry) => entry.id === id);
    },
    `fixture ${command}`,
    8_000,
    cleanup,
  );
  assert.ok(!row.error, row.error);
  const state = row.state;
  if (state)
    assert.equal(state.pid, target.pid, "Fixture state must carry its independently spawned PID.");
  return state ?? row;
}

function request(value, timeout = 12_000) {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(socketPath);
    sockets.add(socket);
    let text = "",
      completed = false;
    const finish = (error, result) => {
      if (completed) return;
      completed = true;
      sockets.delete(socket);
      socket.destroy();
      if (error) reject(error);
      else resolveRequest(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeout, () =>
      finish(new Error("Native request timed out; input must not be replayed.")),
    );
    socket.once("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("data", (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > 4_000_000)
        return finish(new Error("Oversized native response."));
      const end = text.indexOf("\n");
      if (end < 0) return;
      try {
        finish(null, JSON.parse(text.slice(0, end)));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(new Error("Native transport closed without a response.")));
  });
}

function assertFocus() {
  assert.ok(!interrupted, interrupted);
  assert.ok(
    alive(sampler) && latestFocus && performance.now() - focusReceivedAt < 2_000,
    "Live passive focus coverage is required before input.",
  );
  assert.ok(
    baseline && focusFields.every((key) => latestFocus[key] === baseline[key]),
    "The independently observed focus baseline changed.",
  );
}

const inputTools = new Set(["set_value", "press_key", "hotkey", "click"]);
const readTools = new Set(["check_permissions", "list_windows", "get_window_state"]);
async function call(name, args) {
  assert.ok(
    inputTools.has(name) || readTools.has(name),
    "The runner exposes only its bounded native operations.",
  );
  if (name !== "check_permissions") {
    assert.equal(args.pid, target.pid, "Never address a non-fixture PID.");
    if (name !== "list_windows") {
      const own = await fixtureCommand("state");
      assert.ok(
        own.windows.some((window) => window.windowId === args.window_id && window.windowId > 0),
        "Window identity must be declared by the owned AppKit process.",
      );
      if (inputTools.has(name)) {
        assertFocus();
        assert.equal(
          own.active,
          false,
          "The fixture must not become the user's active application.",
        );
        if (name !== "hotkey") {
          assert.equal(
            observedTokens.get(args.element_token)?.windowId,
            args.window_id,
            "Input requires an observed native token belonging to this exact window.",
          );
        }
      }
    }
  }
  const started = performance.now();
  const response = await request({ method: "call", name, args, expected_input_epoch: 0 });
  // A native inventory can include other processes even with a pid query. Do
  // not retain personal window metadata in this runner's evidence.
  let recorded = response;
  if (name === "list_windows" && response.result?.structuredContent) {
    const data = response.result.structuredContent;
    recorded = {
      result: {
        structuredContent: {
          windows: (data.windows ?? []).filter((window) => window.pid === target.pid),
        },
      },
    };
  }
  report.calls.push({
    name,
    args,
    milliseconds: +(performance.now() - started).toFixed(2),
    response: recorded,
  });
  return response;
}

function dataOf(response) {
  assert.ok(
    response && !response.error && response.ok !== false && response.result,
    `Native transport rejected the request: ${JSON.stringify(response?.error ?? response)}`,
  );
  return response.result.structuredContent ?? {};
}
function requireAccepted(response) {
  const data = dataOf(response);
  assert.ok(
    !response.result.isError &&
      !response.isError &&
      data.effect !== "refused" &&
      data.status !== "refused" &&
      !data.refusal,
    `Native operation refused: ${JSON.stringify(data)}`,
  );
  return data;
}

async function observe(windowId, purpose) {
  const data = requireAccepted(
    await call("get_window_state", {
      pid: target.pid,
      window_id: windowId,
      include_screenshot: false,
      max_elements: 1_024,
      max_depth: 25,
    }),
  );
  assert.ok(Array.isArray(data.elements), "The native observation has no elements array.");
  const elements = data.elements
    .filter((element) => typeof element.element_token === "string" && element.element_token.length)
    .map((element) => {
      const observed = { ...element, ref: nextRef++, windowId };
      observedTokens.set(element.element_token, observed);
      return observed;
    });
  const snapshot = { windowId, data, elements };
  report.observations.push({
    purpose,
    windowId,
    snapshotId: data.snapshot_id,
    complete: data.elements_complete,
    elements,
  });
  return snapshot;
}

async function observePanel(purpose) {
  const own = await fixtureCommand("state");
  assert.ok(own.panel, "The expected fixture panel is not open.");
  const inventory = requireAccepted(
    await call("list_windows", { pid: target.pid, include_keyboard_focus: true }),
  );
  const native = (inventory.windows ?? []).filter((window) => window.pid === target.pid);
  const candidates = new Map(
    own.windows.filter((window) => window.visible).map((window) => [window.windowId, window]),
  );
  let current = candidates.get(own.panel.windowId);
  const chain = [];
  const seen = new Set();
  while (current && !seen.has(current.windowId)) {
    seen.add(current.windowId);
    chain.push(current.windowId);
    current = candidates.get(current.attachedSheetWindowId);
  }
  // Deepest AppKit-declared attached sheet first. If the panel shares its
  // parent's native window, inspect that declared parent instead; never pick
  // an arbitrary same-PID sibling or infer a cross-process service owner.
  const ordered = [...chain.reverse(), own.panel.windowId, own.panel.parentWindowId].filter(
    (id, index, all) => id > 0 && all.indexOf(id) === index,
  );
  const windowId = ordered.find((id) => native.some((window) => windowIdOf(window) === id));
  assert.ok(
    windowId,
    `Native inventory did not expose the declared panel/sheet: ${JSON.stringify({ panel: own.panel, windows: own.windows, native })}`,
  );
  return observe(windowId, purpose);
}

const fieldRoles = new Set(["AXTextField", "AXComboBox", "AXTextArea", "AXSearchField"]);
const signature = (element) =>
  JSON.stringify([element.role, element.label ?? "", element.bounds ?? element.frame ?? null]);
const isGoLabel = (element) =>
  /go to|go to the folder|ir para|pasta|aller au dossier|zum ordner/iu.test(element.label ?? "");
function goField(after, before) {
  const beforeFields = new Set(
    before.elements.filter((element) => fieldRoles.has(element.role)).map(signature),
  );
  let candidates = after.elements.filter(
    (element) =>
      fieldRoles.has(element.role) &&
      (after.windowId !== before.windowId ||
        !beforeFields.has(signature(element)) ||
        isGoLabel(element)),
  );
  // Some AppKit versions expose both the combo box and its editable child.
  const inner = candidates.filter((element) => element.role === "AXTextField");
  if (inner.length === 1) candidates = inner;
  assert.equal(
    candidates.length,
    1,
    `Go to Folder needs one freshly observed path field; found ${JSON.stringify(candidates.map(({ ref, role, label }) => ({ ref, role, label })))}`,
  );
  return candidates[0];
}
const tokenArgs = (element) => ({
  pid: target.pid,
  window_id: element.windowId,
  element_token: element.element_token,
});
function button(snapshot, label) {
  const candidates = snapshot.elements.filter(
    (element) => element.role === "AXButton" && normalized(element.label) === normalized(label),
  );
  assert.equal(
    candidates.length,
    1,
    `Expected one exact observed button ${JSON.stringify(label)}.`,
  );
  return candidates[0];
}
function parentValues(state) {
  return state.parents.map(({ label, windowId, value, edits, clicks }) => ({
    label,
    windowId,
    value,
    edits,
    clicks,
  }));
}
function resultFor(state, generation) {
  return state.results.find((result) => result.generation === generation);
}
async function finishPanel(generation) {
  return waitFor(
    async () => resultFor(await fixtureCommand("state"), generation),
    "independent AppKit panel completion",
  );
}
function verifyResult(result, expectedPath) {
  assert.equal(
    result.source,
    "native",
    "Fixture setup/cleanup cannot count as native input success.",
  );
  assert.equal(result.rejectedOutsideFixture, false);
  assert.equal(result.response, expectedPath ? "ok" : "cancel");
  assert.deepEqual(
    result.selectedPaths.map(normalized),
    expectedPath ? [normalized(expectedPath)] : [],
  );
}

async function runReferenceContinuity(before, started) {
  const parent = before.parents.find((entry) => entry.label === "Parent");
  const siblingBefore = before.parents.find((entry) => entry.label === "Sibling");
  const fieldIn = (snapshot) => {
    const fields = snapshot.elements.filter(
      (element) => element.role === "AXTextField" && element.label === "Parent sentinel",
    );
    assert.equal(fields.length, 1, "Exactly one owned field is required.");
    return fields[0];
  };
  const first = await observe(parent.windowId, "reference continuity: initial controls");
  const field = fieldIn(first);
  const counter = button(first, "Parent counter");
  const second = await observe(parent.windowId, "reference continuity: repeated observation");
  assert.equal(
    fieldIn(second).element_token,
    field.element_token,
    "An unchanged AX control must keep its token across fresh observations.",
  );
  // Execute through the first observation's handles, after the second read.
  const value = "  Referência café Ω com espaços  ";
  requireAccepted(await call("set_value", { ...tokenArgs(field), value }));
  const afterWrite = await fixtureCommand("state");
  assert.equal(afterWrite.parents.find((entry) => entry.label === "Parent").value, value);
  const third = await observe(parent.windowId, "reference continuity: after text write");
  assert.equal(fieldIn(third).element_token, field.element_token);
  requireAccepted(
    await call("click", { ...tokenArgs(counter), action: "press", delivery_mode: "background" }),
  );
  const afterClick = await fixtureCommand("state");
  assert.equal(
    afterClick.parents.find((entry) => entry.label === "Parent").clicks,
    parent.clicks + 1,
  );
  assert.deepEqual(
    afterClick.parents.find((entry) => entry.label === "Sibling"),
    siblingBefore,
  );

  const replaced = await fixtureCommand("replace-parent-field");
  const replacementState = replaced.parents.find((entry) => entry.label === "Parent");
  assert.equal(replacementState.replacements, parent.replacements + 1);
  assert.equal(replacementState.value, value);
  const replacement = fieldIn(
    await observe(parent.windowId, "reference continuity: identical replacement"),
  );
  assert.notEqual(
    replacement.element_token,
    field.element_token,
    "A same-label, same-value replacement must have a new native identity.",
  );
  const refused = dataOf(
    await call("set_value", { ...tokenArgs(field), value: "MUST-NOT-ARRIVE" }),
  );
  assert.equal(refused.code ?? refused.refusal?.code, "stale_element_token");
  assert.ok(
    refused.status === "refused" || refused.effect === "refused" || refused.refusal,
    "The removed field must refuse before mutation.",
  );
  const afterRefusal = await fixtureCommand("state");
  assert.deepEqual(
    afterRefusal.parents,
    replaced.parents,
    "A stale ref must not change the identical replacement or sibling.",
  );
  requireAccepted(
    await call("set_value", { ...tokenArgs(replacement), value: "replacement verified" }),
  );
  const final = await fixtureCommand("state");
  assert.equal(
    final.parents.find((entry) => entry.label === "Parent").value,
    "replacement verified",
  );
  assert.equal(final.parents.find((entry) => entry.label === "Parent").clicks, parent.clicks + 1);
  assert.deepEqual(
    final.parents.find((entry) => entry.label === "Sibling"),
    siblingBefore,
  );
  assertFocus();
  report.cases.push({
    name: "reference-continuity",
    passed: true,
    milliseconds: +(performance.now() - started).toFixed(2),
    result: {
      unchangedTokenPreserved: true,
      replacementRefused: true,
      independentValueReadback: true,
      independentClickDelta: 1,
      siblingUnchanged: true,
    },
  });
}

async function runCase(name) {
  const started = performance.now();
  const before = await fixtureCommand("state");
  assert.equal(before.panel, null, "Each case starts with no open panel.");
  if (name === "reference-continuity") return runReferenceContinuity(before, started);
  const parents = parentValues(before);
  let parentField;
  if (name === "parent-refusal") {
    const observation = await observe(
      before.parents.find((parent) => parent.label === "Parent").windowId,
      "retained parent before sheet",
    );
    const matches = observation.elements.filter(
      (element) => element.role === "AXTextField" && element.label === "Parent sentinel",
    );
    assert.equal(matches.length, 1);
    parentField = matches[0];
  }
  assertFocus();
  const kind = ["cancel-sheet", "parent-refusal"].includes(name) ? "open-sheet" : name;
  const opened = await fixtureCommand(kind);
  const generation = opened.generation;
  await waitFor(
    async () => (await fixtureCommand("state")).panel?.visible,
    "visible owned native panel",
  );
  assertFocus();
  let result;
  if (name === "parent-refusal") {
    const response = await call("set_value", {
      ...tokenArgs(parentField),
      value: "MUST-NOT-ARRIVE",
    });
    const data = dataOf(response);
    const code = data.code ?? data.refusal?.code;
    assert.ok(
      data.effect === "refused" ||
        data.status === "refused" ||
        data.refusal?.effect === "not-dispatched",
      "A control behind the sheet must refuse before dispatch.",
    );
    assert.ok(
      [
        "modal_target_mismatch",
        "element_outside_target_window",
        "stale_element_token",
        "stale_target",
        "stale_snapshot",
      ].includes(code),
      `The negative case needs a concrete modal/identity refusal, not an auth/permission failure: ${code}`,
    );
    result = { code, unchanged: parentValues(await fixtureCommand("state")) };
  } else if (name === "cancel-sheet") {
    const snapshot = await observePanel("cancel button");
    const cancelLabels = new Set([
      "cancel",
      "cancelar",
      "annuler",
      "abbrechen",
      "annulla",
      "annuleren",
      "取消",
      "キャンセル",
      "취소",
    ]);
    const matches = snapshot.elements.filter(
      (element) =>
        element.role === "AXButton" &&
        cancelLabels.has(String(element.label ?? "").toLocaleLowerCase()),
    );
    assert.equal(
      matches.length,
      1,
      "One observed native Cancel button is required; do not guess a coordinate.",
    );
    requireAccepted(
      await call("click", {
        ...tokenArgs(matches[0]),
        action: "press",
        delivery_mode: "background",
      }),
    );
    result = await finishPanel(generation);
    verifyResult(result);
  } else {
    const beforePath = await observePanel("before Go to Folder");
    // Exactly one real shortcut; an ambiguous/refused/uncertain attempt is
    // never retried through another window, menu, clipboard, or foreground.
    requireAccepted(
      await call("hotkey", {
        pid: target.pid,
        window_id: beforePath.windowId,
        keys: ["command", "shift", "g"],
        delivery_mode: "background",
      }),
    );
    let pathField;
    await waitFor(
      async () => {
        const after = await observePanel("Go to Folder path field");
        try {
          pathField = goField(after, beforePath);
          return true;
        } catch (error) {
          report.lastFieldDiscovery = String(error);
          return false;
        }
      },
      "new Go to Folder field after the single shortcut",
      6_000,
    );
    const path = name === "save-sheet" ? selectionDirectory : openPath;
    requireAccepted(await call("set_value", { ...tokenArgs(pathField), value: path }));
    const readback = await observe(pathField.windowId, "path field readback");
    const fields = readback.elements.filter(
      (element) =>
        element.role === pathField.role &&
        normalized(element.label) === normalized(pathField.label) &&
        normalized(element.value) === normalized(path),
    );
    assert.equal(
      fields.length,
      1,
      "Exactly one observed field must contain the complete Unicode path before Return.",
    );
    requireAccepted(
      await call("press_key", {
        ...tokenArgs(fields[0]),
        key: "return",
        delivery_mode: "background",
      }),
    );
    // Navigation and acceptance are separate. Directory/readback alone never
    // counts as selecting a file: only the fixture's completion URL does.
    const navigated = await waitFor(
      async () => {
        const state = await fixtureCommand("state");
        return (
          resultFor(state, generation) ||
          (normalized(state.panel?.directory) === normalized(selectionDirectory)
            ? state
            : undefined)
        );
      },
      "Go to Folder navigation or panel completion",
      8_000,
    );
    if (navigated.response) {
      result = navigated;
    } else {
      const confirmation = await observePanel("native panel confirmation");
      const confirm = button(confirmation, name === "save-sheet" ? "Fixture Save" : "Fixture Open");
      requireAccepted(
        await call("click", {
          ...tokenArgs(confirm),
          action: "press",
          delivery_mode: "background",
        }),
      );
      result = await finishPanel(generation);
    }
    verifyResult(result, name === "save-sheet" ? savePath : openPath);
  }
  const after = await fixtureCommand("state");
  assert.deepEqual(
    parentValues(after),
    parents,
    "Neither the parent nor its sibling may be edited or clicked.",
  );
  assertFocus();
  report.cases.push({
    name,
    passed: true,
    generation,
    milliseconds: +(performance.now() - started).toFixed(2),
    result,
    ...(name === "save-sheet" ? { scope: "selected-save-url-only-no-file-write" } : {}),
  });
  if (after.panel) {
    await fixtureCommand("close-panel");
    await waitFor(async () => !(await fixtureCommand("state")).panel, "fixture-only panel cleanup");
  }
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted ??= `Runner interrupted by ${signal}.`;
    for (const socket of sockets) socket.destroy(new Error(interrupted));
  });

try {
  await mkdir(join(fixtureDirectory, "Start here"), { recursive: true });
  await mkdir(selectionDirectory);
  await writeFile(
    join(fixtureDirectory, ".synara-file-dialog-fixture"),
    "owned regression target\n",
    { flag: "wx" },
  );
  await writeFile(openPath, "Synthetic test content. The fixture never reads this file.\n", {
    flag: "wx",
  });
  report.driverSha256 = createHash("sha256")
    .update(await readFile(binaries["--driver"]))
    .digest("hex");
  sampler = launch(binaries["--focus-probe"], [
    "--stdin",
    "--duration",
    "300",
    "--hz",
    "50",
    "--top-win-every",
    "1",
    "--label",
    "native-file-dialog",
  ]);
  const meta = await waitFor(
    () => sampler.rows.find((row) => row.kind === "meta"),
    "focus sampler metadata",
  );
  report.focusMeta = meta;
  assert.equal(
    meta.pid,
    sampler.pid,
    "Focus observations must come from the spawned passive probe.",
  );
  assert.ok(
    meta.axTrusted && meta.axWindowSymbol && meta.slsSpace,
    "The passive sampler needs AX/window/Space coverage; no permission prompt is issued.",
  );
  await waitFor(
    () =>
      latestFocus &&
      focusFields.every((key) => Number.isInteger(latestFocus[key]) && latestFocus[key] > 0),
    "complete passive focus baseline",
  );
  baseline = { ...latestFocus };
  report.baseline = baseline;
  target = launch(binaries["--fixture"], [fixtureDirectory]);
  const ready = await waitFor(
    () => target.rows.find((row) => row.event === "ready"),
    "owned AppKit target ready",
  );
  assert.equal(ready.pid, target.pid);
  assert.equal(ready.state.pid, target.pid);
  assert.equal(ready.state.active, false, "Fixture setup must not activate its application.");
  report.targetPid = target.pid;
  report.initialFixture = ready.state;
  assertFocus();
  driver = launch(
    binaries["--driver"],
    ["serve", "--embedded", "--no-overlay", "--socket", socketPath],
    {
      env: {
        ...process.env,
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_PERMISSION_MODE: "standard",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
        CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
        CUA_DRIVER_EMBEDDED_HOST_PID: String(process.pid),
        CUA_DRIVER_RS_HOME: join(directory, "driver-state"),
      },
    },
  );
  const metadata = await waitFor(
    async () => {
      assert.ok(alive(driver), driver.launchError ?? "Driver exited during startup.");
      try {
        return await request({ method: "metadata" }, 250);
      } catch {
        return undefined;
      }
    },
    "exact driver metadata",
    12_000,
  );
  assert.equal(metadata.result?.pid, driver.pid);
  report.metadata = metadata.result;
  const permissions = requireAccepted(await call("check_permissions", { prompt: false }));
  report.permissions = permissions;
  assert.equal(
    permissions.accessibility,
    true,
    "The explicitly selected driver needs existing AX permission.",
  );
  assert.equal(
    permissions.screen_recording,
    true,
    "The explicitly selected driver needs existing capture permission.",
  );
  for (const name of selectedCases) {
    try {
      await runCase(name);
    } catch (error) {
      report.cases.push({ name, passed: false, error: String(error) });
      throw error;
    }
  }
  await delay(150);
  assertFocus();
  assert.ok(
    report.focusSamples.length >= 5,
    "A passing run requires actual passive focus samples.",
  );
  report.passed =
    report.cases.length === selectedCases.length && report.cases.every((test) => test.passed);
} catch (error) {
  report.failure = String(error);
} finally {
  report.notRun = selectedCases.filter((name) => !report.cases.some((test) => test.name === name));
  // Stop the input producer before closing its target, including after a
  // timeout whose mutation could still be in flight. Only owned PIDs stop.
  if (alive(driver)) {
    try {
      await request({ method: "shutdown_if_pid", args: { expected_pid: driver.pid } }, 1_500);
    } catch (error) {
      report.driverShutdownError = String(error);
    }
    driver.stdin.end();
  }
  if (alive(target)) {
    try {
      report.finalFixture = await fixtureCommand("state", true);
    } catch (error) {
      report.finalStateError = String(error);
    }
    try {
      target.stdin.end(JSON.stringify({ command: "quit" }) + "\n");
    } catch {
      /* Exit is checked below. */
    }
  }
  if (alive(sampler)) sampler.stdin.end();
  for (const child of children) {
    try {
      await waitFor(() => !alive(child), "owned child exit", 1_500, true);
    } catch {
      child.kill("SIGTERM");
      try {
        await waitFor(() => !alive(child), "owned child SIGTERM exit", 1_000, true);
      } catch {
        child.kill("SIGKILL");
        try {
          await waitFor(() => !alive(child), "owned child SIGKILL exit", 1_000, true);
        } catch {
          /* A live child remains an explicit failure in the report. */
        }
      }
    }
    report.cleanup.push({
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      launchError: child.launchError,
      protocolError: child.protocolError,
      diagnostics: child.diagnostics,
      stillRunning: alive(child),
    });
  }
  for (const socket of sockets) socket.destroy();
  await rm(socketDirectory, { recursive: true, force: true });
  report.interrupted = interrupted;
  if (
    interrupted ||
    report.failure ||
    report.driverShutdownError ||
    report.finalStateError ||
    report.cleanup.some(
      (child) =>
        child.stillRunning ||
        child.launchError ||
        child.protocolError ||
        child.exitCode !== 0 ||
        child.signalCode !== null,
    )
  )
    report.passed = false;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        file: reportPath,
        passed: report.passed,
        cases: report.cases,
        notRun: report.notRun,
        failure: report.failure,
        interrupted,
      },
      null,
      2,
    ),
  );
  if (!report.passed) process.exitCode = 1;
}
