// FILE: desktopStaticProtocol.ts
// Purpose: Resolves packaged desktop protocol requests within the prepared static root.
// Layer: Desktop main-process policy

import { existsSync } from "node:fs";
import * as Path from "node:path";

export type DesktopStaticProtocolResponse = { path: string } | { error: -6 };

type PathExists = (path: string) => boolean;

export function createDesktopStaticProtocolResolver(
  staticRoot: string,
  pathExists: PathExists = existsSync,
): (requestUrl: string) => DesktopStaticProtocolResponse {
  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  return (requestUrl) => {
    try {
      const url = new URL(requestUrl);
      const rawPath = decodeURIComponent(url.pathname);
      const normalizedPath = Path.posix.normalize(rawPath).replace(/^\/+/, "");
      const isAssetRequest = Path.extname(url.pathname).length > 0;

      let candidate = fallbackIndex;
      if (!normalizedPath.includes("..")) {
        const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
        const resolvedPath = Path.join(staticRootResolved, requestedPath);
        if (Path.extname(resolvedPath)) {
          candidate = resolvedPath;
        } else {
          const nestedIndex = Path.join(resolvedPath, "index.html");
          candidate = pathExists(nestedIndex) ? nestedIndex : fallbackIndex;
        }
      }

      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      if (!isInRoot || !pathExists(resolvedCandidate)) {
        return isAssetRequest ? { error: -6 } : { path: fallbackIndex };
      }

      return { path: resolvedCandidate };
    } catch {
      return { path: fallbackIndex };
    }
  };
}

/**
 * Switch the shell's next navigation without moving or deleting its bundled
 * root. The backend's HTTP clients continue to use that original directory.
 * Only missing assets fall back, so a new navigation never receives old HTML.
 */
export function createDesktopStaticProtocolSelector(
  bundledRoot: string,
  pathExists: PathExists = existsSync,
) {
  const bundled = createDesktopStaticProtocolResolver(bundledRoot, pathExists);
  let current = bundled;
  let previous: ReturnType<typeof createDesktopStaticProtocolResolver> | null = null;
  return {
    select(currentRoot: string | null, previousRoot: string | null): void {
      current = currentRoot
        ? createDesktopStaticProtocolResolver(currentRoot, pathExists)
        : bundled;
      previous = previousRoot
        ? createDesktopStaticProtocolResolver(previousRoot, pathExists)
        : null;
    },
    resolve(requestUrl: string): DesktopStaticProtocolResponse {
      const response = current(requestUrl);
      if (!("error" in response)) return response;
      const previousResponse = previous?.(requestUrl);
      if (previousResponse && !("error" in previousResponse)) return previousResponse;
      return bundled(requestUrl);
    },
  };
}
