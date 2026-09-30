// FILE: fileReferenceContextMenu.ts
// Purpose: Right-click menu shared by file rows, file previews, and chat file
//          links (editor explorer, changed-file lists, dock file pane).
// Layer: Web UI helpers
// Exports: showFileReferenceContextMenu, getRevealInFolderLabel

import { formatSelectionLabel, type ChatFileReference } from "~/lib/chatReferences";
import { isSupportedLocalImagePath } from "@synara/shared/localPreviewFiles";
import { copyFileContentsToClipboard, copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { downloadUrlAsBlob } from "~/lib/browserDownload";
import {
  canCopyFileToDesktopClipboard,
  copyFileToDesktopClipboard,
  copyImageToClipboard,
  fetchFileClipboardBlob,
  resolveFileClipboardUrl,
  type FileClipboardSource,
} from "~/lib/desktopClipboard";
import { localImageFileName } from "~/lib/localImageUrls";
import { getNavigatorPlatform, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

export function getRevealInFolderLabel(platform: string): string {
  if (isWindowsPlatform(platform)) {
    return "Open in Explorer";
  }
  if (isMacPlatform(platform)) {
    return "Reveal in Finder";
  }
  return "Show in folder";
}

export interface FileReferenceClipboardInput {
  path: string;
  fileForCopy?: FileClipboardSource | undefined;
  contentsForCopy?: string | null | undefined;
  truncated?: boolean | undefined;
}

interface FileReferenceClipboardAction {
  id: "copy-file" | "copy-image" | "copy-contents" | "download-file";
  label: string;
  run: () => Promise<void>;
}

/** Same actions and feedback in the header and every file-reference context menu. */
export function getFileReferenceClipboardActions(
  input: FileReferenceClipboardInput,
): FileReferenceClipboardAction[] {
  const actions: FileReferenceClipboardAction[] = [];
  const source = input.fileForCopy;
  const filename = localImageFileName(input.path) || "file";
  const copy = async (kind: "file" | "image", write: () => Promise<boolean>) => {
    try {
      if (!(await write())) throw new Error("Clipboard access unavailable.");
      toastManager.add({
        type: "success",
        title: kind === "image" ? "Image copied" : "File copied",
        description: filename,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Failed to copy ${kind}`,
        // Do not expose resource URLs, grants or file contents from fetch/IPC errors.
        description:
          error instanceof Error && error.message.startsWith("Files larger than")
            ? "Files larger than 64 MB must be downloaded instead of copied."
            : "Clipboard access failed or the file is unavailable. Try Download file.",
      });
    }
  };
  if (source && isSupportedLocalImagePath(input.path)) {
    actions.push({
      id: "copy-image",
      label: "Copy image",
      run: () =>
        copy("image", async () => copyImageToClipboard(await fetchFileClipboardBlob(source))),
    });
  }
  if (source && canCopyFileToDesktopClipboard()) {
    actions.push({
      id: "copy-file",
      label: "Copy file",
      run: () => copy("file", () => copyFileToDesktopClipboard(source, filename)),
    });
  }
  if (input.contentsForCopy != null) {
    actions.push({
      id: "copy-contents",
      label: "Copy contents",
      run: () =>
        copyFileContentsToClipboard(input.contentsForCopy ?? "", filename, {
          partial: input.truncated ?? false,
        }),
    });
  }
  if (source) {
    actions.push({
      id: "download-file",
      label: "Download file",
      run: async () => {
        try {
          const url = await resolveFileClipboardUrl(source);
          await downloadUrlAsBlob({ url, filename });
        } catch {
          toastManager.add({
            type: "error",
            title: "Failed to download file",
            description: "The file may have moved or access may have expired. Try reopening it.",
          });
        }
      },
    });
  }
  return actions;
}

// Right-click menu shared by explorer rows, changed-file rows, and the file
// preview. Falls back to a DOM menu outside the desktop app.
export async function showFileReferenceContextMenu(
  input: FileReferenceClipboardInput & {
    /** Absolute path to reveal in the platform file manager. Omit when the
     * surface only knows a repository-relative path. */
    revealPath?: string;
    position: { x: number; y: number };
    /** Line/column range from source views, or a quoted snippet from surfaces
     * without stable source lines (rendered markdown preview). */
    selection?: Omit<ChatFileReference, "path"> | null;
    onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
    onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  },
): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  const revealPath =
    input.revealPath && typeof window !== "undefined" && window.desktopBridge
      ? input.revealPath
      : undefined;
  const reference: ChatFileReference = {
    path: input.path,
    ...input.selection,
  };
  const rangeLabel = formatSelectionLabel(reference);
  const hasSnippet = typeof reference.snippet === "string" && reference.snippet.trim().length > 0;
  const clipboardActions = getFileReferenceClipboardActions(input);
  const clicked = await api.contextMenu.show(
    [
      ...(input.onReferenceInChat
        ? [
            {
              id: "reference-in-chat" as const,
              label: rangeLabel
                ? `Reference ${rangeLabel} in chat`
                : hasSnippet
                  ? "Reference selection in chat"
                  : "Reference in chat",
            },
          ]
        : []),
      ...(input.onAskWhyInChat
        ? [
            {
              id: "ask-why-in-chat" as const,
              label: rangeLabel ? `Ask why ${rangeLabel} changed` : "Ask why this changed",
            },
          ]
        : []),
      ...(revealPath
        ? [
            {
              id: "reveal-in-folder" as const,
              label: getRevealInFolderLabel(getNavigatorPlatform()),
            },
          ]
        : []),
      { id: "copy-path" as const, label: "Copy path" },
      ...clipboardActions.map(({ id, label }) => ({ id, label })),
    ],
    input.position,
  );
  if (clicked === "reference-in-chat") {
    input.onReferenceInChat?.(reference);
    return;
  }
  if (clicked === "ask-why-in-chat") {
    input.onAskWhyInChat?.(reference);
    return;
  }
  if (clicked === "reveal-in-folder" && revealPath) {
    try {
      await api.shell.showInFolder(revealPath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to reveal file",
        description:
          error instanceof Error ? error.message : "An unknown error occurred opening the file.",
      });
    }
    return;
  }
  if (clicked === "copy-path") {
    try {
      await copyTextToClipboard(input.path);
    } catch {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: "Clipboard access was denied or is unavailable.",
      });
    }
    return;
  }
  await clipboardActions.find((action) => action.id === clicked)?.run();
}
