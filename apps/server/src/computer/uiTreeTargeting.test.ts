import { describe, expect, it } from "vitest";

import type { ComputerUiNode, ComputerWindowId } from "@synara/contracts";
import {
  bindComputerTargetRef,
  computerElementRefIdentity,
  observedComputerTargetNode,
  registerNativeComputerElement,
} from "./computerElementIdentity.ts";

import {
  ComputerTargetError,
  activationPointForNode,
  actionableElements,
  computerTargetCandidates,
  diffActionableElements,
  resolveComputerPoint,
  resolveComputerSemanticTarget,
  resolveComputerUniqueTextTarget,
  type ComputerActionableElement,
} from "./uiTreeTargeting.ts";

const windowId = (value: string): ComputerWindowId => value as ComputerWindowId;

function node(partial: Partial<ComputerUiNode> & { readonly role: string }): ComputerUiNode {
  return {
    role: partial.role,
    label: partial.label ?? null,
    value: partial.value ?? null,
    description: partial.description ?? null,
    frame: partial.frame ?? { x: 0, y: 0, width: 1_920, height: 1_080 },
    activationPoint: partial.activationPoint ?? null,
    onScreen: partial.onScreen ?? true,
    windowId: partial.windowId ?? null,
    ...(partial.editable === undefined ? {} : { editable: partial.editable }),
    ...(partial.truncated === undefined ? {} : { truncated: partial.truncated }),
    children: partial.children ?? [],
  };
}

const DESKTOP = node({
  role: "desktop",
  description: "AT-SPI desktop",
  children: [
    node({
      role: "push button",
      label: "Save",
      windowId: windowId("editor"),
      frame: { x: 100, y: 200, width: 80, height: 30 },
      activationPoint: { x: 140, y: 215 },
    }),
    node({
      role: "push button",
      label: "Save As",
      windowId: windowId("editor"),
      frame: { x: 200, y: 200, width: 80, height: 30 },
    }),
    node({
      role: "menu item",
      label: "Save",
      windowId: windowId("browser"),
      frame: { x: 900, y: 200, width: 80, height: 30 },
    }),
  ],
});

function thrown(run: () => unknown): ComputerTargetError {
  try {
    run();
  } catch (cause) {
    return cause as ComputerTargetError;
  }
  throw new Error("expected a ComputerTargetError");
}

describe("resolving a coordinate target", () => {
  const screen = { width: 1_920, height: 1_080, scale: 1 };

  it("refuses half a coordinate and a coordinate past the edge", () => {
    const half = thrown(() => resolveComputerPoint({ x: 10 }, screen));
    expect(half.code).toBe("computer_target_invalid");
    const past = thrown(() => resolveComputerPoint({ x: 1_920, y: 10 }, screen));
    expect(past.code).toBe("computer_target_offscreen");
  });
});

describe("resolving a labelled desktop target", () => {
  it("returns the control's own activation point when it has one", () => {
    const match = resolveComputerSemanticTarget(DESKTOP, {
      label: "Save",
      role: "push button",
    });
    expect(match.point).toEqual({ x: 140, y: 215 });
    expect(match.node.windowId).toBe("editor");
  });

  it("falls back to the frame centre for a control with no activation point", () => {
    const plain = node({
      role: "x",
      frame: { x: 10, y: 20, width: 100, height: 40 },
    });
    expect(activationPointForNode(plain)).toEqual({ x: 60, y: 40 });
  });

  it("prefers an exact label over a longer one that contains it", () => {
    const target = { label: "Save", windowId: windowId("editor") };
    expect(resolveComputerSemanticTarget(DESKTOP, target).node.frame.x).toBe(100);
  });

  it("scopes matching to the named window", () => {
    const target = { label: "Save", windowId: windowId("browser") };
    expect(resolveComputerSemanticTarget(DESKTOP, target).node.role).toBe("menu item");
  });

  it("falls back to substring when no label matches exactly", () => {
    expect(resolveComputerSemanticTarget(DESKTOP, { label: "ave As" }).node.label).toBe("Save As");
  });

  it("compares a role verbatim rather than loosely", () => {
    // AT-SPI role names are a fixed vocabulary, so a near miss is a wrong role
    // and not a spelling to be forgiven.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { role: "Push Button" }));
    expect(error.code).toBe("computer_target_not_found");
  });

  it("matches a label without trimming the query", () => {
    // Nothing trims a label arriving over MCP, and quietly acting on a control
    // the caller did not name is worse than a refusal they can correct.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: " Save " }));
    expect(error.code).toBe("computer_target_not_found");
  });

  it("matches a visible form label containing a non-breaking space", () => {
    const field = node({ role: "AXTextField", label: "First name\u00a0*" });
    const desktop = node({
      role: "desktop",
      children: [field, node({ role: "AXTextField", label: "First name * (optional)" })],
    });
    expect(resolveComputerSemanticTarget(desktop, { label: "First name *" }).node).toBe(field);
  });

  it("refuses ambiguity between labels differing only in non-breaking spaces", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({ role: "AXTextField", label: "First name\u00a0*" }),
        node({ role: "AXTextField", label: "First name *" }),
      ],
    });
    const error = thrown(() => resolveComputerSemanticTarget(desktop, { label: "First name *" }));
    expect(error.code).toBe("computer_target_ambiguous");
    expect(error.candidates).toHaveLength(2);
  });

  it("refuses a label that names a control in two windows", () => {
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: "Save" }));
    expect(error.code).toBe("computer_target_ambiguous");
    expect(error.candidates).toHaveLength(2);
  });

  it("trusts the perception source's own on-screen flag", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "push button",
          label: "Hidden",
          onScreen: false,
          // On screen by coordinates; the source knows better, and is believed.
          frame: { x: 10, y: 10, width: 80, height: 30 },
        }),
      ],
    });
    const error = thrown(() => resolveComputerSemanticTarget(desktop, { label: "Hidden" }));
    expect(error.code).toBe("computer_target_offscreen");
    expect(error.candidates).toHaveLength(1);
    expect(resolveComputerSemanticTarget(desktop, { label: "Hidden" }, true).node.label).toBe(
      "Hidden",
    );
  });
});

describe("resolving the sole writable text control in a window", () => {
  it("selects an unlabelled native text area without guessing across windows", () => {
    const editor = node({
      role: "AXTextArea",
      windowId: windowId("editor"),
      frame: { x: 20, y: 40, width: 300, height: 200 },
    });
    const desktop = node({
      role: "desktop",
      children: [
        editor,
        node({ role: "AXTextArea", windowId: windowId("other") }),
        node({ role: "AXButton", label: "Save", windowId: windowId("editor") }),
      ],
    });

    expect(resolveComputerUniqueTextTarget(desktop, "editor").node).toBe(editor);
  });

  it("refuses multiple writable controls and names each candidate", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "AXTextField",
          label: "Title",
          windowId: windowId("editor"),
        }),
        node({
          role: "AXTextArea",
          label: "Body",
          windowId: windowId("editor"),
        }),
      ],
    });

    const error = thrown(() => resolveComputerUniqueTextTarget(desktop, "editor"));
    expect(error.code).toBe("computer_target_ambiguous");
    expect(error.candidates.map((candidate) => candidate.label)).toEqual(["Title", "Body"]);
  });

  it("does not select a text-shaped control explicitly marked read-only", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "AXTextArea",
          label: "Transcript",
          editable: false,
          windowId: windowId("editor"),
        }),
      ],
    });

    const error = thrown(() => resolveComputerUniqueTextTarget(desktop, "editor"));
    expect(error.code).toBe("computer_target_not_found");
  });

  it("can retain an exact writable control after its window leaves the active Space", () => {
    const editor = node({
      role: "AXTextArea",
      label: "Body",
      windowId: windowId("editor"),
      onScreen: false,
    });
    const desktop = node({ role: "desktop", children: [editor] });

    expect(resolveComputerUniqueTextTarget(desktop, "editor", true).node).toBe(editor);
    expect(() => resolveComputerUniqueTextTarget(desktop, "editor")).toThrow(ComputerTargetError);
  });
});

describe("naming the candidates", () => {
  it("puts the candidates in the message, not only in the structured field", () => {
    // Every transport between here and the model — MCP tool errors, WsRpcError —
    // is only guaranteed to carry the message, and a "no such label" with no
    // list of the real ones is a dead end.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: "Print" }));
    expect(error.code).toBe("computer_target_not_found");
    expect(error.candidates.length).toBeGreaterThan(0);
    expect(error.message).toContain("Save As");
    expect(error.message).toContain("push button");
    expect(error.message).toContain('in window "editor"');
  });

  it("caps a candidate list at sixteen entries", () => {
    const desktop = node({
      role: "desktop",
      children: Array.from({ length: 40 }, (_unused, index) =>
        node({ role: "push button", label: `Button ${index}` }),
      ),
    });
    // The root counts too: the cap is on the flattened list, not on the children.
    expect(computerTargetCandidates(desktop)).toHaveLength(16);
    const error = thrown(() => resolveComputerSemanticTarget(desktop, { label: "Nope" }));
    expect(error.candidates).toHaveLength(16);
  });
});

/**
 * The digest is what makes labels discoverable to the model: without it the
 * only grounding is pixel estimation from a downscaled screenshot, which is
 * exactly the clunkiness this exists to remove.
 */
describe("actionableElements", () => {
  it("shows native selection changes even when an item's label and value stay the same", () => {
    const row = node({ role: "AXRow", label: "File", windowId: windowId("panel") });
    registerNativeComputerElement(row, "file-token", ["select"], false);
    const before = actionableElements(row).items;
    expect(before[0]).toMatchObject({ actions: ["select"], selected: false });
    registerNativeComputerElement(row, "file-token", ["select"], true);
    const after = actionableElements(row).items;
    expect(diffActionableElements(before, after).changed).toMatchObject([
      { label: "File", selected: true },
    ]);
    registerNativeComputerElement(row, "file-token", ["select"]);
    expect(diffActionableElements(after, actionableElements(row).items).changed).toMatchObject([
      { label: "File", selected: null },
    ]);
  });

  it("finds non-breaking-space labels through the same query used for targeting", () => {
    const field = node({
      role: "AXTextField",
      label: "First name\u00a0*",
      windowId: windowId("browser"),
    });
    const result = actionableElements(node({ role: "desktop", children: [field] }), {
      windowId: "browser",
      labelContains: "FIRST NAME *",
    });
    expect(result.items.map((item) => item.label)).toEqual(["First name\u00a0*"]);
    expect(result.complete).toBe(true);
  });

  it("lists labeled on-screen actionable elements in tree order", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "push button",
          label: "Reload",
          windowId: windowId("browser"),
          children: [
            node({
              role: "entry",
              label: "Email",
              value: "",
              windowId: windowId("browser"),
            }),
          ],
        }),
        node({
          role: "heading",
          label: "Settings",
          windowId: windowId("browser"),
        }),
      ],
    });

    expect(actionableElements(desktop)).toEqual({
      complete: true,
      sourceIncomplete: false,
      omitted: 0,
      items: [
        { ref: 0, role: "push button", label: "Reload", windowId: windowId("browser") },
        {
          ref: 1,
          role: "entry",
          label: "Email",
          value: "",
          windowId: windowId("browser"),
        },
      ],
      refIndex: [
        { label: "Reload", role: "push button", windowId: "browser", ordinal: 0 },
        { label: "Email", role: "entry", windowId: "browser", ordinal: 0 },
      ],
    });
  });

  it("drops unlabeled controls, static text, and off-screen elements", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({ role: "push button", windowId: windowId("w") }),
        node({
          role: "text",
          label: "A paragraph of static text",
          windowId: windowId("w"),
        }),
        node({
          role: "check box",
          label: "Off screen",
          onScreen: false,
          windowId: windowId("w"),
        }),
        node({
          role: "check box",
          label: "Subscribed",
          windowId: windowId("w"),
        }),
      ],
    });

    expect(actionableElements(desktop).items).toEqual([
      { ref: 0, role: "check box", label: "Subscribed", windowId: windowId("w") },
    ]);
  });

  it("falls back to the description when there is no label, matching targeting", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "slider",
          description: "Volume",
          windowId: windowId("player"),
        }),
      ],
    });

    // Targeting matches on `label ?? description`, so the digest must name the
    // element by the same words or the model could not act on it by label.
    expect(actionableElements(desktop).items).toEqual([
      { ref: 0, role: "slider", label: "Volume", windowId: windowId("player") },
    ]);
  });

  it("keeps native file rows and unnamed fields bound to their exact retained controls", () => {
    const first = node({ role: "AXTextField", windowId: windowId("panel"), value: "" });
    const second = node({ role: "AXTextField", windowId: windowId("panel"), value: "" });
    const row = node({ role: "AXRow", label: "arquivo ação.txt", windowId: windowId("panel") });
    registerNativeComputerElement(first, "native:first");
    registerNativeComputerElement(second, "native:second");
    registerNativeComputerElement(row, "native:file", ["AXPress", "AXShowMenu"]);
    const digest = actionableElements(node({ role: "desktop", children: [first, second, row] }));
    expect(digest.items).toHaveLength(3);
    expect(digest.items[1]).toMatchObject({ label: "", value: "", frame: second.frame });
    expect(digest.items[2]).toMatchObject({
      role: "AXRow",
      label: "arquivo ação.txt",
      actions: ["AXPress", "AXShowMenu"],
    });
    expect(computerElementRefIdentity(digest.refIndex[0]!)).toBe("native:first");
    expect(computerElementRefIdentity(digest.refIndex[1]!)).toBe("native:second");
    const target = bindComputerTargetRef(
      { label: "", role: "AXTextField", windowId: "panel" },
      digest.refIndex[1]!,
    );
    expect(observedComputerTargetNode(target)).toBe(second);
    expect(observedComputerTargetNode(JSON.parse(JSON.stringify(target)))).toBeUndefined();
    expect(
      actionableElements(node({ role: "desktop", children: [JSON.parse(JSON.stringify(row))] }))
        .items,
    ).toEqual([]);
  });

  it("still scopes, filters and counts native controls that have no label", () => {
    const fields = Array.from({ length: 65 }, (_, index) => {
      const field = node({ role: "AXTextField", windowId: windowId("panel") });
      registerNativeComputerElement(field, `native:${index}`);
      return field;
    });
    const hidden = node({ role: "AXRow", windowId: windowId("panel"), onScreen: false });
    registerNativeComputerElement(hidden, "native:hidden", ["AXPress"]);
    const tree = node({ role: "desktop", children: [...fields, hidden] });
    expect(actionableElements(tree)).toMatchObject({ complete: false, omitted: 5 });
    expect(actionableElements(tree, { windowId: "another-panel" }).items).toEqual([]);
    expect(actionableElements(tree, { labelContains: "Go to Folder" }).items).toEqual([]);
  });

  it("does not let retained decorative nodes hide an unnamed native path control", () => {
    const decoration = Array.from({ length: 65 }, (_, index) => {
      const text = node({
        role: "AXStaticText",
        label: `Text ${index}`,
        windowId: windowId("panel"),
      });
      registerNativeComputerElement(text, `decoration:${index}`);
      return text;
    });
    const field = node({ role: "AXTextField", windowId: windowId("panel") });
    registerNativeComputerElement(field, "path-field");
    const digest = actionableElements(node({ role: "desktop", children: [...decoration, field] }));
    expect(digest.items).toHaveLength(1);
    expect(digest.complete).toBe(true);
    expect(computerElementRefIdentity(digest.refIndex[0]!)).toBe("path-field");
  });

  it("reports newly available actions and moved unnamed fields even when values are unchanged", () => {
    const field: ComputerActionableElement = {
      ref: 1,
      role: "AXTextField",
      label: "",
      value: "",
      windowId: "panel",
      frame: { x: 0, y: 0, width: 80, height: 20 },
    };
    const moved = { ...field, frame: { ...field.frame!, x: 10 }, actions: ["AXConfirm"] };
    expect(diffActionableElements([field], [moved]).changed).toEqual([
      {
        ref: 1,
        role: "AXTextField",
        label: "",
        windowId: "panel",
        was: "",
        value: "",
        frame: moved.frame,
        actions: ["AXConfirm"],
      },
    ]);
    expect(diffActionableElements([moved], [field]).changed[0]?.actions).toEqual([]);
  });

  it("keeps duplicate labels — real ambiguity — but separates windows", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "push button",
          label: "Save",
          windowId: windowId("editor"),
        }),
        node({
          role: "push button",
          label: "Save",
          windowId: windowId("editor"),
        }),
        node({
          role: "menu item",
          label: "Save",
          windowId: windowId("browser"),
        }),
      ],
    });

    const elements = actionableElements(desktop);
    expect(elements.complete).toBe(true);
    expect(elements.items).toHaveLength(3);
    expect(elements.items[0]?.windowId).toBe(windowId("editor"));
    expect(elements.items.at(-1)?.windowId).toBe(windowId("browser"));
  });

  it("truncates long labels and values on whole characters", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "entry",
          label: `x`.repeat(300),
          value: "v".repeat(200),
          windowId: windowId("editor"),
        }),
      ],
    });

    const [element] = actionableElements(desktop).items;
    expect(element?.label.length).toBeLessThanOrEqual(80);
    expect(element?.value?.length).toBeLessThanOrEqual(40);
  });

  it("caps the list and reports when it had to cut elements off", () => {
    const desktop = node({
      role: "desktop",
      children: Array.from({ length: 80 }, (_unused, index) =>
        node({
          role: "push button",
          label: `Button ${index}`,
          windowId: windowId("panel"),
          children: [
            node({
              role: "link",
              label: "child link",
              windowId: windowId("panel"),
            }),
          ],
        }),
      ),
    });

    const elements = actionableElements(desktop);
    expect(elements.items).toHaveLength(60);
    expect(elements.complete).toBe(false);
  });
});

it("includes native macOS controls and reports a partial accessibility source", () => {
  const tree = node({
    role: "desktop",
    truncated: true,
    children: [
      node({ role: "AXButton", label: "Save", windowId: windowId("native") }),
      node({
        role: "AXMenuBarItem",
        label: "File",
        windowId: windowId("native"),
      }),
    ],
  });
  const result = actionableElements(tree);
  expect(result.items.map((item) => item.label)).toEqual(["Save", "File"]);
  expect(result.complete).toBe(false);
  expect(result.sourceIncomplete).toBe(true);
});

describe("diffActionableElements", () => {
  const element = (
    label: string,
    extra: Partial<ComputerActionableElement> = {},
  ): ComputerActionableElement => ({
    ref: 0,
    role: "push button",
    label,
    windowId: windowId("editor"),
    ...extra,
  });

  const nativeElement = (
    identity: string,
    ref: number,
    overrides: Partial<ComputerUiNode> = {},
  ): ComputerActionableElement => {
    const control = node({
      role: "AXTextField",
      label: "Field",
      value: "same value",
      windowId: windowId("editor"),
      ...overrides,
    });
    registerNativeComputerElement(control, identity);
    // The gateway stamps refs with a spread before retaining its digest.
    return { ...actionableElements(control).items[0]!, ref };
  };

  it("keeps native identity through spreads without exposing it in JSON", () => {
    const item = nativeElement("private-token", 17);
    expect(computerElementRefIdentity({ ...item })).toBe("private-token");
    const wire = JSON.parse(JSON.stringify(item));
    expect(computerElementRefIdentity(wire)).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain("private-token");
    // A JSON copy cannot claim to be the native control it resembles.
    expect(diffActionableElements([item], [wire])).toMatchObject({
      added: [wire],
      removed: [item],
      changed: [],
    });
  });

  it("reports a native rename with the same identity and ref", () => {
    const before = nativeElement("field-token", 17);
    const after = nativeElement("field-token", 17, { label: "Renamed field" });
    expect(diffActionableElements([before], [after])).toEqual({
      added: [],
      removed: [],
      changed: [
        {
          ref: 17,
          role: "AXTextField",
          label: "Renamed field",
          windowId: "editor",
          was: "same value",
          value: "same value",
        },
      ],
    });
  });

  it("pairs reordered native duplicates by token instead of label or position", () => {
    const first = nativeElement("first-token", 17, { value: "first value" });
    const second = nativeElement("second-token", 18, { value: "second value" });
    expect(
      diffActionableElements(
        [first, second],
        [
          nativeElement("second-token", 18, { value: "second value" }),
          nativeElement("first-token", 17, { value: "first value" }),
        ],
      ),
    ).toEqual({ added: [], removed: [], changed: [] });
  });

  it("reports an identical native replacement as removed and added", () => {
    const before = nativeElement("old-token", 17);
    const after = nativeElement("replacement-token", 18);
    expect(diffActionableElements([before], [after])).toEqual({
      added: [after],
      removed: [before],
      changed: [],
    });
  });

  it("reports a new native ref even when every visible field stays unchanged", () => {
    const before = nativeElement("field-token", 17);
    const after = nativeElement("field-token", 513);
    expect(diffActionableElements([before], [after])).toMatchObject({
      added: [],
      removed: [],
      changed: [{ ref: 513, label: "Field", value: "same value", was: "same value" }],
    });
    expect(diffActionableElements([after], [{ ...after }])).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it.each([{ role: "AXComboBox" }, { windowId: windowId("browser") }])(
    "scopes native identity to role and window: %j",
    (scope) => {
      const before = nativeElement("shared-token", 17);
      const after = nativeElement("shared-token", 18, scope);
      expect(diffActionableElements([before], [after])).toEqual({
        added: [after],
        removed: [before],
        changed: [],
      });
    },
  );

  it("reports every element as added against an empty baseline", () => {
    const after = [element("Save"), element("Cancel")];
    expect(diffActionableElements([], after)).toEqual({
      added: after,
      removed: [],
      changed: [],
    });
  });

  it("separates added, removed, and value-changed entries", () => {
    const before = [element("Save"), element("Display", { value: "0" }), element("Help")];
    const after = [element("Save"), element("Display", { value: "42" }), element("About")];
    expect(diffActionableElements(before, after)).toEqual({
      added: [element("About")],
      removed: [element("Help")],
      changed: [
        {
          ref: 0,
          role: "push button",
          label: "Display",
          windowId: windowId("editor"),
          was: "0",
          value: "42",
        },
      ],
    });
  });

  it("treats a reordering of the same elements as no change", () => {
    const before = [element("Save"), element("Cancel")];
    const after = [element("Cancel"), element("Save")];
    expect(diffActionableElements(before, after)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("keeps duplicate labels distinct by count", () => {
    const before = [element("Save"), element("Save")];
    const after = [element("Save")];
    expect(diffActionableElements(before, after)).toEqual({
      added: [],
      removed: [element("Save")],
      changed: [],
    });
  });

  it("separates identical labels across windows", () => {
    const before = [
      element("Save", { windowId: windowId("editor") }),
      element("Save", { windowId: windowId("browser") }),
    ];
    const after = [element("Save", { windowId: windowId("editor") })];
    expect(diffActionableElements(before, after)).toEqual({
      added: [],
      removed: [element("Save", { windowId: windowId("browser") })],
      changed: [],
    });
  });

  it("reports a gained or lost value as a change, not a remove-add pair", () => {
    const before = [element("Notes")];
    const after = [element("Notes", { value: "draft text" })];
    expect(diffActionableElements(before, after).changed).toEqual([
      {
        ref: 0,
        role: "push button",
        label: "Notes",
        windowId: windowId("editor"),
        value: "draft text",
      },
    ]);
    expect(diffActionableElements(after, before).changed).toEqual([
      {
        ref: 0,
        role: "push button",
        label: "Notes",
        windowId: windowId("editor"),
        was: "draft text",
      },
    ]);
  });
});

describe("resolving a duplicate by ordinal", () => {
  const twoSaves = node({
    role: "desktop",
    children: [
      node({
        role: "window",
        label: "Editor",
        windowId: windowId("editor"),
        children: [
          node({
            role: "push button",
            label: "Save",
            windowId: windowId("editor"),
            activationPoint: { x: 10, y: 10 },
          }),
          node({
            role: "push button",
            label: "Save",
            windowId: windowId("editor"),
            activationPoint: { x: 20, y: 20 },
          }),
        ],
      }),
    ],
  });

  it("picks the ordinal-th control sharing the exact identity", () => {
    const match = resolveComputerSemanticTarget(twoSaves, {
      label: "Save",
      refOrdinal: 1,
    });
    expect(match.point).toEqual({ x: 20, y: 20 });
  });

  it.each([false, true])(
    "refuses a disappeared ordinal instead of targeting the sole survivor (allowOffscreen=%s)",
    (allowOffscreen) => {
      const oneSave = node({
        role: "desktop",
        children: [
          node({
            role: "push button",
            label: "Save",
            windowId: windowId("editor"),
            activationPoint: { x: 10, y: 10 },
          }),
        ],
      });
      const error = thrown(() =>
        resolveComputerSemanticTarget(oneSave, { label: "Save", refOrdinal: 1 }, allowOffscreen),
      );
      expect(error.code).toBe("computer_target_not_found");
      expect(error.notFound).toBe(true);
      expect(error.message).toContain("Observe again with computer_get_state");
    },
  );

  it("refuses a disappeared ordinal even when multiple controls survive", () => {
    const error = thrown(() =>
      resolveComputerSemanticTarget(twoSaves, { label: "Save", refOrdinal: 2 }),
    );
    expect(error.code).toBe("computer_target_not_found");
    expect(error.candidates).toHaveLength(2);
  });
});

describe("actionableElements ref data", () => {
  it("indexes each item with its full identity and duplicate ordinal", () => {
    const tree = node({
      role: "desktop",
      children: [
        node({
          role: "window",
          windowId: windowId("editor"),
          children: [
            node({
              role: "push button",
              label: "Save",
              windowId: windowId("editor"),
            }),
            node({
              role: "push button",
              label: "Save",
              windowId: windowId("editor"),
            }),
          ],
        }),
      ],
    });
    const digest = actionableElements(tree);
    expect(digest.items.map((item) => item.ref)).toEqual([0, 1]);
    expect(digest.refIndex).toEqual([
      { label: "Save", role: "push button", windowId: "editor", ordinal: 0 },
      { label: "Save", role: "push button", windowId: "editor", ordinal: 1 },
    ]);
  });

  it("keeps the full label in the ref index when the wire label clamps", () => {
    const longLabel = "x".repeat(200);
    const tree = node({
      role: "desktop",
      children: [
        node({
          role: "window",
          windowId: windowId("editor"),
          children: [
            node({
              role: "push button",
              label: longLabel,
              windowId: windowId("editor"),
            }),
          ],
        }),
      ],
    });
    const digest = actionableElements(tree);
    expect(digest.items[0]!.label.length).toBeLessThan(longLabel.length);
    expect(digest.refIndex[0]!.label).toBe(longLabel);
  });
});
