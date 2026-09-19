// FILE: release-stage-dependencies.ts
// Purpose: Verifies the installed desktop runtime dependency closure without falling back to the checkout.
// Layer: Release/build helper

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

interface InstalledPackage {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
}

export function collectStageRuntimePackages(
  stageAppDir: string,
  runtimeDependencyNames: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const stageRoot = realpathSync(stageAppDir);
  const packages = new Map<string, string[]>();
  const visited = new Set<string>();
  const pending = runtimeDependencyNames.map((name) => ({
    name,
    parent: stageRoot,
    optional: false,
  }));

  function resolvePackage(name: string, parent: string): string | undefined {
    let directory = parent;
    while (true) {
      const candidate = join(directory, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) {
        const resolved = realpathSync(candidate);
        const relativePath = relative(stageRoot, resolved);
        if (
          relativePath === ".." ||
          relativePath.startsWith(`..${sep}`) ||
          isAbsolute(relativePath)
        ) {
          throw new Error(
            `Runtime dependency ${name} resolves outside the release stage: ${resolved}`,
          );
        }
        return resolved;
      }
      if (directory === stageRoot) return undefined;
      directory = dirname(directory);
    }
  }

  for (let index = 0; index < pending.length; index += 1) {
    const dependency = pending[index]!;
    const packageDirectory = resolvePackage(dependency.name, dependency.parent);
    if (!packageDirectory) {
      if (dependency.optional) continue;
      throw new Error(
        `Required runtime dependency ${dependency.name} is missing from the release stage (from ${dependency.parent}).`,
      );
    }
    if (visited.has(packageDirectory)) continue;
    visited.add(packageDirectory);
    const manifest = JSON.parse(
      readFileSync(join(packageDirectory, "package.json"), "utf8"),
    ) as InstalledPackage;
    const packageName = manifest.name ?? dependency.name;
    const locations = packages.get(packageName) ?? [];
    locations.push(packageDirectory);
    packages.set(packageName, locations);

    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      const optional =
        Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
        (!Object.hasOwn(manifest.dependencies ?? {}, name) &&
          manifest.peerDependenciesMeta?.[name]?.optional === true);
      pending.push({ name, parent: packageDirectory, optional });
    }
  }
  return packages;
}
