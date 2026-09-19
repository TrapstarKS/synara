import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectStageRuntimePackages } from "./release-stage-dependencies.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synara-stage-dependencies-"));
  roots.push(root);
  const stage = join(root, "stage");
  mkdirSync(stage);
  function addPackage(name: string, fields: Record<string, unknown> = {}, parent = stage) {
    const directory = join(parent, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...fields }),
    );
    return directory;
  }
  return { root, stage, addPackage };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("collectStageRuntimePackages", () => {
  it("follows runtime dependencies and peers through cycles without requiring development tools", () => {
    const { stage, addPackage } = fixture();
    addPackage("runtime", {
      dependencies: { transitive: "1" },
      peerDependencies: { peer: "1" },
      devDependencies: { "build-only": "1" },
    });
    addPackage("transitive", { dependencies: { runtime: "1" } });
    addPackage("peer");
    addPackage("unused-web");
    expect([...collectStageRuntimePackages(stage, ["runtime"]).keys()].toSorted()).toEqual([
      "peer",
      "runtime",
      "transitive",
    ]);
  });

  it("keeps separate nested copies so every runtime copy of a patched package can be checked", () => {
    const { stage, addPackage } = fixture();
    const first = addPackage("first", { dependencies: { shared: "1" } });
    addPackage("second", { dependencies: { shared: "2" } });
    const nested = addPackage("shared", {}, first);
    const hoisted = addPackage("shared", { version: "2.0.0" });
    const packages = collectStageRuntimePackages(stage, ["first", "second"]);
    expect(packages.get("shared")).toEqual([realpathSync(nested), realpathSync(hoisted)]);
  });

  it.each(["dependencies", "peerDependencies"])("rejects missing mandatory %s", (field) => {
    const { stage, addPackage } = fixture();
    addPackage("runtime", { [field]: { missing: "1" } });
    expect(() => collectStageRuntimePackages(stage, ["runtime"])).toThrow(
      "Required runtime dependency missing is missing",
    );
  });

  it("does not resolve a missing root from the checkout or any ancestor outside the stage", () => {
    const { root, stage, addPackage } = fixture();
    addPackage("ancestor-only", {}, root);
    expect(() => collectStageRuntimePackages(stage, ["ancestor-only"])).toThrow(
      "Required runtime dependency ancestor-only is missing",
    );
  });

  it("allows absent platform optional dependencies and optional peers but follows installed ones", () => {
    const { stage, addPackage } = fixture();
    addPackage("runtime", {
      dependencies: { "optional-override": "1" },
      optionalDependencies: { "optional-override": "1", native: "1", installed: "1" },
      peerDependencies: { peer: "1" },
      peerDependenciesMeta: { peer: { optional: true } },
    });
    addPackage("installed", { dependencies: { required: "1" } });
    addPackage("required");
    expect([...collectStageRuntimePackages(stage, ["runtime"]).keys()].toSorted()).toEqual([
      "installed",
      "required",
      "runtime",
    ]);
  });

  it("does not let optional peer metadata hide a required runtime dependency", () => {
    const { stage, addPackage } = fixture();
    addPackage("runtime", {
      dependencies: { required: "1" },
      peerDependencies: { required: "1" },
      peerDependenciesMeta: { required: { optional: true } },
    });
    expect(() => collectStageRuntimePackages(stage, ["runtime"])).toThrow(
      "Required runtime dependency required is missing",
    );
  });

  it("rejects package links that would package dependencies from outside the isolated stage", () => {
    const { root, stage, addPackage } = fixture();
    const external = addPackage("external", {}, root);
    mkdirSync(join(stage, "node_modules"));
    symlinkSync(external, join(stage, "node_modules", "external"), "junction");
    expect(() => collectStageRuntimePackages(stage, ["external"])).toThrow(
      "resolves outside the release stage",
    );
  });
});
