// FILE: composerDropPaths.ts
// Purpose: Resolve absolute paths for OS-dropped files on desktop and decide
//          when a drop should become a path mention instead of a byte attachment.
// Layer: Web composer utility (desktop-aware)

import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@synara/contracts";

export interface ComposerDroppedFileItem {
  readonly kind: string;
  readonly getAsFile: () => File | null;
  readonly webkitGetAsEntry?: (() => { readonly isDirectory?: boolean } | null) | undefined;
}

export interface SplitDroppedComposerFilesResult {
  readonly pathMentions: string[];
  readonly imageFiles: File[];
  readonly genericFiles: File[];
  /** File-system directory items that Chromium exposed without a File object. */
  readonly unresolvedDirectories: number;
}

/**
 * Best-effort absolute path for a File from a drag/drop or file picker.
 * On Electron, uses `webUtils.getPathForFile` via the desktop bridge.
 */
export function resolveDroppedFileAbsolutePath(file: File): string | null {
  const legacyPath = (file as File & { readonly path?: unknown }).path;
  if (typeof legacyPath === "string" && legacyPath.trim().length > 0) {
    return legacyPath;
  }
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  const getPath = bridge?.getPathForFile;
  if (typeof getPath !== "function") {
    return null;
  }
  try {
    const path = getPath(file);
    if (typeof path !== "string" || path.trim().length === 0) {
      return null;
    }
    return path;
  } catch {
    return null;
  }
}

/** Chromium exposes directory identity on the drag item, not reliably on File. */
export function isDroppedComposerDirectory(item: ComposerDroppedFileItem | undefined): boolean {
  if (!item || item.kind !== "file" || typeof item.webkitGetAsEntry !== "function") {
    return false;
  }
  try {
    return item.webkitGetAsEntry()?.isDirectory === true;
  } catch {
    return false;
  }
}

function getDroppedItemFile(item: ComposerDroppedFileItem | undefined): File | null {
  if (!item) {
    return null;
  }
  try {
    return item.getAsFile();
  } catch {
    return null;
  }
}

export function splitDroppedComposerFiles(input: {
  readonly files: Iterable<File>;
  readonly items?: Iterable<ComposerDroppedFileItem>;
}): SplitDroppedComposerFilesResult {
  const fallbackFiles = Array.from(input.files);
  const fileItems = input.items
    ? Array.from(input.items).filter((item) => item.kind === "file")
    : [];
  const pathMentions: string[] = [];
  const imageFiles: File[] = [];
  const genericFiles: File[] = [];
  const seenPaths = new Set<string>();
  let unresolvedDirectories = 0;

  const addFile = (file: File, item?: ComposerDroppedFileItem) => {
    const absolutePath = resolveDroppedFileAbsolutePath(file);
    if (isDroppedComposerDirectory(item)) {
      if (absolutePath) {
        if (!seenPaths.has(absolutePath)) {
          seenPaths.add(absolutePath);
          pathMentions.push(absolutePath);
        }
      } else {
        unresolvedDirectories += 1;
      }
      return;
    }

    // A desktop drop can represent a large file by its local path even though
    // the bounded byte-upload path cannot accept it. Keep the drop useful by
    // referencing that path instead of silently rejecting the file.
    if (!file.type.startsWith("image/") && file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
      if (absolutePath) {
        if (!seenPaths.has(absolutePath)) {
          seenPaths.add(absolutePath);
          pathMentions.push(absolutePath);
        }
        return;
      }
    }

    if (file.type.startsWith("image/")) {
      imageFiles.push(file);
    } else {
      genericFiles.push(file);
    }
  };

  if (fileItems.length === 0) {
    for (const file of fallbackFiles) addFile(file);
  } else {
    // DataTransfer.files may omit directories, while DataTransfer.items still
    // contains them. Only use positional fallback when both collections have
    // the same cardinality; otherwise never attach a neighbouring file to a
    // folder item by accident.
    const positionalFallback =
      fallbackFiles.length === fileItems.length ? fallbackFiles : undefined;
    const consumedFiles = new Set<File>();

    for (let index = 0; index < fileItems.length; index += 1) {
      const item = fileItems[index];
      const file = getDroppedItemFile(item) ?? positionalFallback?.[index];
      if (!file) {
        if (isDroppedComposerDirectory(item)) unresolvedDirectories += 1;
        continue;
      }
      consumedFiles.add(file);
      addFile(file, item);
    }

    // Some browser implementations expose additional files only through the
    // FileList. Keep those files, but don't duplicate a file already returned
    // by its DataTransferItem.
    if (fallbackFiles.length > fileItems.length) {
      for (const file of fallbackFiles) {
        if (!consumedFiles.has(file)) addFile(file);
      }
    }
  }

  return { pathMentions, imageFiles, genericFiles, unresolvedDirectories };
}
