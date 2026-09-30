// FILE: workspaceFileOpener.ts
// Purpose: Context + helpers that let file references rendered deep in the
//          chat tree (markdown links, mention chips, work-log rows) open in an
//          in-app workspace file viewer (right-dock file pane or editor pane)
//          instead of an external editor.
// Layer: Web UI helpers
// Exports: WorkspaceFileOpenerContext, useWorkspaceFileOpener,
//          resolveWorkspaceFileOpenTarget, resolveScratchPreviewFileOpenTarget,
//          resolveDockFileOpenTarget,
//          openWorkspaceFileReference, prefetchWorkspaceFile

import { isSupportedLocalPreviewFilePath } from "@synara/shared/localPreviewFiles";
import {
  isLocalAbsolutePath,
  isWorkspaceRelativePathSafe,
  localPathsEqual,
  workspaceRelativePathOf,
} from "@synara/shared/path";
import { isScratchWorkspacePath } from "@synara/shared/threadWorkspace";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useLayoutEffect, useRef } from "react";

import { openInPreferredEditor } from "../editorPreferences";
import { readNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";
import { filesystemStatQueryOptions, projectReadFileQueryOptions } from "./projectReactQuery";

interface WorkspaceFileOpenOptions {
  external?: boolean;
}

export interface WorkspaceFileOpener {
  /**
   * Handles activation of a local reference. False leaves the reference to the
   * shared external fallback when this surface cannot handle it.
   */
  openFile: (path: string, options?: WorkspaceFileOpenOptions) => boolean;
  /** Optional hover warm-up for the file contents + syntax highlighter. */
  prefetchFile?: (path: string) => void;
}

export const WorkspaceFileOpenerContext = createContext<WorkspaceFileOpener | null>(null);

export function useWorkspaceFileOpener(): WorkspaceFileOpener | null {
  return useContext(WorkspaceFileOpenerContext);
}

// Trailing `:line` / `:line:col` suffix carried by resolved markdown file links.
// The in-app viewer previews whole files, so the position is dropped.
const FILE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const TRAILING_PATH_SEPARATOR_PATTERN = /[\\/]+$/;
const SYNARA_PUBLIC_ASSET_PATH_PREFIXES = [
  "/central-icons-reversed/",
  "/central-icons-fill/",
] as const;
const SYNARA_WEB_PUBLIC_WORKSPACE_DIR = "apps/web/public";

function resolveSynaraPublicAssetOpenTarget(path: string, workspaceRoot: string | null) {
  if (!workspaceRoot) {
    return null;
  }
  const normalizedPath = path.replace(/\\/g, "/");
  if (!SYNARA_PUBLIC_ASSET_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))) {
    return null;
  }
  const relativePath = `${SYNARA_WEB_PUBLIC_WORKSPACE_DIR}${normalizedPath}`;
  return isWorkspaceRelativePathSafe(relativePath) ? relativePath : null;
}

/**
 * Maps directory references that can be identified without a filesystem probe
 * to the workspace-relative path expected by the Explorer. The workspace root
 * is always known to be a directory; descendants are treated as directories
 * only when the reference keeps an explicit trailing separator.
 *
 * An empty string means the workspace root itself. Null means the reference is
 * not a known in-workspace directory and should continue through file opening.
 */
export function resolveWorkspaceDirectoryOpenTarget(
  rawPath: string,
  workspaceRoot: string | null,
): string | null {
  if (!workspaceRoot) {
    return null;
  }
  const withoutPosition = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (withoutPosition.length === 0) {
    return null;
  }
  // Relative Markdown links can retain harmless "." segments after cwd is
  // joined. Keep ".." intact so the containment checks still reject traversal.
  const directoryPath = withoutPosition
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/");
  if (localPathsEqual(directoryPath, workspaceRoot)) {
    return "";
  }
  if (!TRAILING_PATH_SEPARATOR_PATTERN.test(withoutPosition)) {
    return null;
  }
  const withoutTrailingSeparators = directoryPath.replace(TRAILING_PATH_SEPARATOR_PATTERN, "");
  if (isWorkspaceRelativePathSafe(withoutTrailingSeparators)) {
    return withoutTrailingSeparators.replaceAll("\\", "/");
  }
  return workspaceRelativePathOf(withoutTrailingSeparators, workspaceRoot);
}

/**
 * Maps a chat file reference (workspace-relative, or absolute as produced by
 * `resolveMarkdownFileLinkTarget`, optionally with a `:line:col` suffix) to the
 * workspace-relative path the file-read RPC expects. Returns null when the
 * reference points outside the workspace.
 */
export function resolveWorkspaceFileOpenTarget(
  rawPath: string,
  workspaceRoot: string | null,
): string | null {
  const withoutPosition = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (withoutPosition.length === 0) {
    return null;
  }
  if (isWorkspaceRelativePathSafe(withoutPosition)) {
    return withoutPosition;
  }
  if (!workspaceRoot) {
    return null;
  }
  const workspaceRelativePath = workspaceRelativePathOf(withoutPosition, workspaceRoot);
  if (workspaceRelativePath) {
    return workspaceRelativePath;
  }
  // CentralIcon assets are linked in chat as Vite root URLs
  // (`/central-icons-...`) but the file viewer needs the repo path.
  return resolveSynaraPublicAssetOpenTarget(withoutPosition, workspaceRoot);
}

/**
 * Out-of-workspace fallback for surfaces that can preview binary files: a
 * session that starts before its chat workspace exists runs in a scratch
 * directory under the OS temp dir, and the agent references those files by
 * absolute path. Images, videos and PDFs stream through the allowlisted local-image
 * route (which also serves the scratch root), so they can still open in-app.
 * Anything else returns null — the text file-read RPC only accepts
 * workspace-relative paths, so those references fall back to the external
 * editor.
 */
export function resolveScratchPreviewFileOpenTarget(rawPath: string): string | null {
  const withoutPosition = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (!isScratchWorkspacePath(withoutPosition)) {
    return null;
  }
  return isSupportedLocalPreviewFilePath(withoutPosition) ? withoutPosition : null;
}

// Right-dock file panes can show workspace files plus absolute local paths.
// Relative paths still require a workspace; absolute paths are read as-is.
export function resolveDockFileOpenTarget(
  rawPath: string,
  workspaceRoot: string | null,
): string | null {
  const withoutPosition = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (withoutPosition.length === 0) {
    return null;
  }
  const workspaceTarget = workspaceRoot
    ? resolveWorkspaceFileOpenTarget(rawPath, workspaceRoot)
    : null;
  if (workspaceTarget) {
    return workspaceTarget;
  }
  if (isLocalAbsolutePath(withoutPosition)) {
    return withoutPosition;
  }
  return resolveScratchPreviewFileOpenTarget(rawPath);
}

/**
 * Shared activation path for clickable file references: try the surface's
 * in-app viewer first, fall back to the preferred external editor when the
 * reference isn't viewable in-app (path outside the workspace, no opener).
 * Pass a null opener to force the external editor (e.g. meta/ctrl-click).
 */
export function openWorkspaceFileReference(
  opener: WorkspaceFileOpener | null,
  path: string,
  options?: WorkspaceFileOpenOptions,
): void {
  if (options?.external ? opener?.openFile(path, options) : opener?.openFile(path)) {
    return;
  }
  void activateWorkspacePath({ path, workspaceRoot: null, external: true }).catch(
    showPathOpenError,
  );
}

function showPathOpenError(error: unknown): void {
  toastManager.add({
    type: "error",
    title: "Could not open this location",
    description: error instanceof Error ? error.message : "The location is unavailable.",
  });
}

interface WorkspacePathActions {
  workspaceRoot: string | null;
  openFile?: (path: string) => boolean;
  openDirectory?: (relativePath: string) => void;
}

export async function activateWorkspacePath(
  input: WorkspacePathActions & {
    path: string;
    external?: boolean;
    isCurrent?: () => boolean;
  },
): Promise<void> {
  const api = readNativeApi();
  if (!api) throw new Error("Connection is unavailable. Try again after reconnecting.");
  const rawPath = input.path.trim();
  const position = FILE_POSITION_SUFFIX_PATTERN.exec(rawPath)?.[0] ?? "";
  const targetPath =
    resolveSynaraPublicAssetOpenTarget(
      rawPath.replace(FILE_POSITION_SUFFIX_PATTERN, ""),
      input.workspaceRoot,
    ) ?? rawPath.replace(FILE_POSITION_SUFFIX_PATTERN, "");
  const target = await api.filesystem.stat({
    path: targetPath,
    ...(input.workspaceRoot ? { cwd: input.workspaceRoot } : {}),
  });
  if (input.isCurrent?.() === false) return;
  if (target.kind === "directory" || target.kind === "other") {
    if (
      !input.external &&
      target.kind === "directory" &&
      target.workspaceRelativePath !== null &&
      !target.workspaceRelativePath
        .split("/")
        .some((segment) => segment.toLowerCase() === ".git") &&
      input.openDirectory
    ) {
      input.openDirectory(target.workspaceRelativePath);
    } else {
      await api.shell.openInEditor(target.path, "file-manager");
    }
    return;
  }
  if (target.kind === "missing" && TRAILING_PATH_SEPARATOR_PATTERN.test(targetPath)) {
    throw new Error("This folder no longer exists at the linked location.");
  }
  const filePath = target.kind === "file" ? `${target.path}${position}` : rawPath;
  if (!input.external && input.openFile?.(filePath)) return;
  if (target.kind === "missing") throw new Error("This location no longer exists.");
  await openInPreferredEditor(api, filePath, input.isCurrent);
}

export function useWorkspacePathOpener(
  input: WorkspacePathActions & {
    scopeKey: string;
    enabled: boolean;
    prefetchFile?: (path: string) => void;
  },
): WorkspaceFileOpener {
  const requestRef = useRef(0);
  useLayoutEffect(() => {
    requestRef.current += 1;
    return () => {
      requestRef.current += 1;
    };
  }, [input.scopeKey, input.workspaceRoot, input.enabled]);
  return {
    openFile: (path, options) => {
      if (!input.enabled) return false;
      const request = ++requestRef.current;
      const isCurrent = () => requestRef.current === request;
      void activateWorkspacePath({
        ...input,
        path,
        ...(options?.external ? { external: true } : {}),
        isCurrent,
      }).catch((error: unknown) => {
        if (isCurrent()) showPathOpenError(error);
      });
      return true;
    },
    ...(input.prefetchFile ? { prefetchFile: input.prefetchFile } : {}),
  };
}

/**
 * Hover warm-up so the file pane opens instantly: file contents go through the
 * shared React Query cache, and the matching Shiki highlighter loads in the
 * background. The highlighter module is imported dynamically so chat-adjacent
 * chunks don't pull Shiki eagerly.
 */
export function prefetchWorkspaceFile(
  queryClient: QueryClient,
  workspaceRoot: string,
  relativePath: string,
): void {
  // Images, videos and PDFs stream through the local-image HTTP route, so there is no
  // text read to warm and no syntax highlighter to load.
  if (isSupportedLocalPreviewFilePath(relativePath)) {
    return;
  }
  // Bare filenames (no directory) usually do not exist at the workspace root and
  // make the read RPC fall back to a tracked-index lookup, which can build the
  // workspace index. Skip warming those on hover so a pointer sweep over many
  // such references never triggers repeated index builds; the click-to-open
  // path still resolves them on demand.
  if (!relativePath.includes("/")) {
    return;
  }
  void queryClient
    .fetchQuery(filesystemStatQueryOptions({ cwd: workspaceRoot, path: relativePath }))
    .then(async (target) => {
      if (target.kind !== "file") return;
      await Promise.all([
        queryClient.prefetchQuery(
          projectReadFileQueryOptions({ cwd: workspaceRoot, relativePath }),
        ),
        import("./syntaxHighlighting").then((module) =>
          module.getSyntaxHighlighterPromise(module.getSyntaxLanguageForPath(relativePath)),
        ),
      ]);
    })
    .catch(() => undefined);
}
