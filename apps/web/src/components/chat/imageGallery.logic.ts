// FILE: imageGallery.logic.ts
// Purpose: Collect every image shared in a chat into one recency-ordered, deduplicated gallery.
// Layer: Pure chat UI logic

import type { ChatMessage } from "~/types";
import {
  buildLocalImageUrl,
  isLocalImageMarkdownSrc,
  localImageFileName,
} from "~/lib/localImageUrls";
import type { WorkLogEntry } from "../../workLog";

export interface ChatGalleryImage {
  id: string;
  src: string;
  name: string;
  origin: "You" | "Agent";
  createdAt: string;
}

export type ChatGalleryWorkEntry = Pick<
  WorkLogEntry,
  | "id"
  | "createdAt"
  | "detail"
  | "tone"
  | "toolStatus"
  | "liveActivity"
  | "itemType"
  | "activityKind"
  | "toolDetails"
>;

const MARKDOWN_IMAGE_PATTERN =
  /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;

function isPreviewableImageSource(src: string): boolean {
  if (/^(?:https?:|blob:|data:image\/|\/api\/)/i.test(src.trim())) return true;
  return isLocalImageMarkdownSrc(src);
}

function nameFromSource(src: string): string {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  return localImageFileName(withoutQuery) || "Image";
}

// Absolute image paths as tools print them, e.g. codex-media's "Saved 1 image:\n/…/a.png"
// or a browser proof's `"artifactPath":"/…/b.png"`.
const ABSOLUTE_IMAGE_PATH_PATTERN =
  /(?<![\w.~:/-])((?:\/|[A-Za-z]:\\)[^\s"'<>|*?]*?\.(?:png|jpe?g|gif|webp))(?![\w-])/gi;

/**
 * Image files a completed tool call reports writing. Codex's native image
 * generation has its own item type; every other provider (Claude via the
 * codex-media MCP, browser proofs) only returns the saved path as tool text.
 */
export function extractToolResultImagePaths(entry: ChatGalleryWorkEntry): string[] {
  const details = entry.toolDetails;
  if (details?.kind !== "tool-call" || entry.tone === "error" || details.success === false) {
    return [];
  }
  // Serialized results keep JSON escapes; undo the ones that can border a path.
  const text = [details.result, details.structuredResult]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .replaceAll("\\\\", "\\")
    .replace(/\\[nrt"]/g, " ");
  return [...new Set([...text.matchAll(ABSOLUTE_IMAGE_PATH_PATTERN)].map((match) => match[1]!))];
}

function isCompletedToolEntry(entry: ChatGalleryWorkEntry): boolean {
  if (entry.tone === "error") {
    return false;
  }
  if (entry.toolStatus === "failed" || entry.toolStatus === "cancelled") {
    return false;
  }
  if (entry.toolStatus === "running" || entry.toolStatus === "paused") {
    return false;
  }
  if (entry.liveActivity?.state === "failed" || entry.liveActivity?.state === "cancelled") {
    return false;
  }
  return (
    (entry.activityKind === undefined && entry.liveActivity === undefined) ||
    entry.activityKind === "tool.completed" ||
    entry.liveActivity?.state === "completed"
  );
}

export function extractMarkdownImages(markdown: string): Array<{ src: string; alt: string }> {
  return [...markdown.matchAll(MARKDOWN_IMAGE_PATTERN)].flatMap((match) => {
    const src = (match[2] ?? match[3] ?? "").trim();
    if (!isPreviewableImageSource(src)) return [];
    return [{ src, alt: (match[1] ?? "").trim() }];
  });
}

export function collectChatGalleryImages(
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "text" | "attachments" | "createdAt">>,
  workEntries: ReadonlyArray<ChatGalleryWorkEntry> = [],
): ChatGalleryImage[] {
  const images: ChatGalleryImage[] = [];
  const seenSources = new Set<string>();
  const add = (image: ChatGalleryImage) => {
    const key = image.src.trim();
    if (!key || seenSources.has(key)) return;
    seenSources.add(key);
    images.push(image);
  };

  for (const message of messages) {
    const origin = message.role === "user" ? "You" : "Agent";
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image" || !attachment.previewUrl) continue;
      add({
        id: `${message.id}:attachment:${attachment.id}`,
        src: attachment.previewUrl,
        name: attachment.name,
        origin,
        createdAt: message.createdAt,
      });
    }
    for (const [index, image] of extractMarkdownImages(message.text).entries()) {
      add({
        id: `${message.id}:markdown:${index}`,
        src: image.src,
        name: image.alt || nameFromSource(image.src),
        origin,
        createdAt: message.createdAt,
      });
    }
  }

  for (const workEntry of workEntries) {
    if (!isCompletedToolEntry(workEntry)) continue;
    for (const [index, src] of extractToolResultImagePaths(workEntry).entries()) {
      add({
        id: `${workEntry.id}:tool-image:${index}`,
        src,
        name: nameFromSource(src),
        origin: "Agent",
        createdAt: workEntry.createdAt,
      });
    }
    const src = workEntry.detail?.trim();
    if (!src || workEntry.itemType !== "image_generation" || !isPreviewableImageSource(src)) {
      continue;
    }
    add({
      id: `${workEntry.id}:generated-image`,
      src,
      name: isLocalImageMarkdownSrc(src) ? nameFromSource(src) : "Generated image",
      origin: "Agent",
      createdAt: workEntry.createdAt,
    });
  }

  return images.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function resolveChatGalleryPreviewUrl(src: string, cwd: string | null): string {
  return isLocalImageMarkdownSrc(src) ? buildLocalImageUrl({ src, cwd: cwd ?? undefined }) : src;
}
