// FILE: desktopClipboard.ts
// Purpose: Clipboard image/file writes from scoped downloads, with bounded transfers.
// Layer: Web desktop bridge utility
// Exports: image/file clipboard helpers and their scoped resource source.

import { MAX_DESKTOP_CLIPBOARD_FILE_BYTES } from "@synara/contracts";
import { LOCAL_IMAGE_ROUTE_PATH } from "@synara/shared/localPreviewFiles";
import { isLocalAbsolutePath } from "@synara/shared/path";
import { ensureNativeApi } from "~/nativeApi";
import { buildLocalImageUrl } from "./localImageUrls";
import { resolveWsHttpUrl } from "./wsHttpUrl";

export interface FileClipboardSource {
  readonly url: string;
  /** Renew expiring grants only after a user requests the operation. */
  readonly resolveUrl?: (() => Promise<string>) | undefined;
}

export function createLocalFileClipboardSource(input: {
  path: string;
  cwd?: string | null | undefined;
}): FileClipboardSource {
  const url = buildLocalImageUrl({ src: input.path, cwd: input.cwd ?? undefined, download: true });
  // Parsing only: URLSearchParams preserves the builder's decoded grant target in SSR too.
  const normalizedPath = new URL(url, "http://localhost").searchParams.get("path") ?? input.path;
  return {
    url,
    ...(isLocalAbsolutePath(normalizedPath)
      ? {
          resolveUrl: async () => {
            const { grant } = await ensureNativeApi().projects.createLocalFilePreviewGrant({
              path: normalizedPath,
            });
            return buildLocalImageUrl({
              src: input.path,
              cwd: input.cwd ?? undefined,
              download: true,
              grant,
            });
          },
        }
      : {}),
  };
}

export function canCopyFileToDesktopClipboard(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.desktopBridge?.clipboard?.writeFile === "function"
  );
}

class FileClipboardError extends Error {}

export async function resolveFileClipboardUrl(source: FileClipboardSource): Promise<string> {
  try {
    const url = source.resolveUrl ? await source.resolveUrl() : source.url;
    const parsed = new URL(url, window.location.href);
    const server = new URL(resolveWsHttpUrl(LOCAL_IMAGE_ROUTE_PATH), window.location.href);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== server.origin ||
      parsed.pathname !== LOCAL_IMAGE_ROUTE_PATH ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error();
    }
    return parsed.href;
  } catch {
    throw new FileClipboardError(
      "The scoped file download is unavailable. Try reopening the file.",
    );
  }
}

export async function fetchFileClipboardBlob(source: FileClipboardSource): Promise<Blob> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const tooLarge = () =>
    new FileClipboardError("Files larger than 64 MB must be downloaded instead of copied.");
  const incomplete = () =>
    new FileClipboardError("Could not copy the complete file. Try downloading it again.");
  try {
    const url = await resolveFileClipboardUrl(source);
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
    if (response.status !== 200 || response.headers.has("Content-Range")) {
      throw new FileClipboardError(`Could not copy the complete file (HTTP ${response.status}).`);
    }
    const lengthHeader = response.headers.get("Content-Length");
    if (lengthHeader !== null && !/^\d+$/u.test(lengthHeader)) throw incomplete();
    const size = lengthHeader === null ? null : Number(lengthHeader);
    if (size !== null && size > MAX_DESKTOP_CLIPBOARD_FILE_BYTES) {
      controller.abort();
      throw tooLarge();
    }
    const reader = response.body?.getReader();
    if (!reader) {
      if (size !== 0) throw incomplete();
      return new Blob([]);
    }
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_DESKTOP_CLIPBOARD_FILE_BYTES) {
          controller.abort();
          throw tooLarge();
        }
        chunks.push(new Uint8Array(next.value));
      }
    } finally {
      reader.releaseLock();
    }
    if (size !== null && !response.headers.has("Content-Encoding") && bytes !== size) {
      throw incomplete();
    }
    return new Blob(chunks, {
      type: response.headers.get("Content-Type") ?? "application/octet-stream",
    });
  } catch (error) {
    // Fetch errors can contain signed URLs. Only expose errors constructed here.
    if (error instanceof FileClipboardError) throw error;
    throw new Error("Could not load the file for copying. Try downloading it again.");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function copyFileToDesktopClipboard(
  source: FileClipboardSource,
  name: string,
): Promise<boolean> {
  const writeFile =
    typeof window === "undefined" ? undefined : window.desktopBridge?.clipboard?.writeFile;
  if (!writeFile) return false;
  const blob = await fetchFileClipboardBlob(source);
  try {
    return await writeFile({ name, bytes: new Uint8Array(await blob.arrayBuffer()) });
  } catch {
    return false;
  }
}

export async function copyImageToClipboard(blob: Blob): Promise<boolean> {
  try {
    const png = blob.type.split(";")[0] === "image/png" ? blob : await imageBlobToPng(blob);
    if (await copyPngBlobToDesktopClipboard(png)) return true;
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

async function imageBlobToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width * bitmap.height > 16_777_216) throw new Error("Image is too large to copy.");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion unavailable.");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("Image conversion failed."))),
        "image/png",
      );
    });
  } finally {
    bitmap.close();
  }
}

export async function copyPngBlobToDesktopClipboard(blob: Blob): Promise<boolean> {
  const writeImagePngDataUrl =
    typeof window === "undefined"
      ? undefined
      : window.desktopBridge?.clipboard?.writeImagePngDataUrl;
  if (!writeImagePngDataUrl) {
    return false;
  }

  const dataUrl = await blobToDataUrl(blob);
  if (!dataUrl?.startsWith("data:image/png;base64,")) {
    return false;
  }

  try {
    return await writeImagePngDataUrl(dataUrl);
  } catch {
    return false;
  }
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  if (typeof FileReader === "undefined") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(blob);
  });
}
